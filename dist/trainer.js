(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const storageKey = 'blackjack-lab:learning:v1';
  const rules = ['all', 'original'];
  const format = new Intl.NumberFormat('zh-CN');
  const batchLimit = 1000;
  const testRounds = 10000;
  const resetDialog = $('reset-model-dialog');
  let { lossRule, models } = load();
  let job = null;
  let evaluating = false;

  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey));
      if (stored && rules.includes(stored.lossRule) && stored.models) {
        const models = {};
        for (const rule of rules) {
          const model = stored.models[rule];
          if (model?.lossRule === rule && Number.isInteger(model.rounds) && model.table && model.simulation) models[rule] = model;
        }
        return { lossRule: stored.lossRule, models };
      }
    } catch {
      // A blocked or missing profile can still train a model in memory.
    }
    return { lossRule: 'all', models: {} };
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ lossRule, models }));
      $('model-storage').textContent = '本机';
      $('model-storage-detail').textContent = current()?.rounds ? '模型已保存' : '选择训练参数开始';
    } catch {
      $('model-storage').textContent = '内存';
      $('model-storage-detail').textContent = '存储不可用，关闭窗口后会丢失';
    }
  }

  function current() {
    return models[lossRule];
  }

  function status(message, error = false) {
    $('training-status').textContent = message;
    $('training-status').classList.toggle('training-error', error);
  }

  function renderControls() {
    const model = current();
    $('model-rounds').textContent = format.format(model?.rounds ?? 0);
    $('model-states').textContent = format.format(model?.table ? Object.keys(model.table).length : 0);
    $('model-decisions').textContent = format.format(model?.decisions ?? 0);
    const busy = Boolean(job) || evaluating;
    for (const id of ['batch-size', 'training-players', 'training-loss', 'train-start']) $(id).disabled = busy;
    $('train-start').textContent = model?.rounds ? '继续训练' : '开始训练';
    $('train-stop').hidden = !job;
    $('train-reset').disabled = busy || !model?.rounds;
    $('evaluate').disabled = busy || !model?.rounds;
    $('evaluate').textContent = evaluating ? '正在评估…' : '运行评估';
  }

  function progress(completed, total, detail) {
    $('train-progress').max = Math.max(1, total);
    $('train-progress').value = completed;
    $('progress-count').textContent = total ? `${format.format(completed)} / ${format.format(total)} 局${detail ? ` · ${detail}` : ''}` : detail;
  }

  function startTraining() {
    if (job || evaluating) return;
    if (!current()) models[lossRule] = BlackjackTraining.createModel({ lossRule });
    job = { completed: 0, target: Number($('batch-size').value), otherPlayers: Number($('training-players').value) };
    $('evaluation-results').replaceChildren();
    progress(0, job.target, '训练中');
    status('正在模拟发牌、行动和结算。每批结束后自动保存。');
    renderControls();
    scheduleBatch(job);
  }

  function scheduleBatch(active) {
    setTimeout(() => { if (job === active) trainBatch(); }, 15);
  }

  function trainBatch() {
    const rounds = Math.min(batchLimit, job.target - job.completed);
    try {
      const batch = BlackjackTraining.train(current(), { rounds, otherPlayers: job.otherPlayers });
      job.completed += batch.rounds;
      save();
      if (job.completed >= job.target) return stopTraining('完成');
      progress(job.completed, job.target, '训练中');
      renderControls();
      scheduleBatch(job);
    } catch (error) {
      const failed = job;
      job = null;
      progress(failed.completed, failed.target, '已停止');
      renderControls();
      status(`训练未完成。${error.message}`, true);
    }
  }

  function stopTraining(detail) {
    if (!job) return;
    const finished = job;
    job = null;
    progress(finished.completed, finished.target, detail);
    renderControls();
    status(`本次已训练 ${format.format(finished.completed)} 局。可以继续累积训练或运行独立评估。`);
  }

  function formatNet(perRound) {
    return `${perRound > 0 ? '+' : ''}${(perRound * 100).toFixed(2)}`;
  }

  function showEvaluation(results, otherPlayers) {
    const summary = document.createElement('p');
    summary.className = 'evaluation-caption';
    summary.textContent = `每种策略 ${format.format(results.rounds)} 局 · ${otherPlayers} 名模拟其他玩家`;

    const list = document.createElement('div');
    list.className = 'evaluation-results';
    for (const [title, result] of [['学习策略', results.learned], ['固定基准', results.baseline]]) {
      const row = document.createElement('article');
      const label = document.createElement('span');
      label.textContent = title;
      const amount = document.createElement('strong');
      amount.textContent = formatNet(result.netPerRound);
      const detail = document.createElement('small');
      detail.textContent = `净单位／100 局 · 赢 ${(100 * result.winRate).toFixed(1)}%`;
      row.append(label, amount, detail);
      list.append(row);
    }
    $('evaluation-results').replaceChildren(summary, list);
  }

  function evaluate() {
    if (job || evaluating || !current()?.rounds) return;
    const otherPlayers = Number($('training-players').value);
    evaluating = true;
    renderControls();
    setTimeout(() => {
      try {
        const results = BlackjackTraining.evaluate(current(), { rounds: testRounds, otherPlayers });
        showEvaluation(results, otherPlayers);
      } catch (error) {
        status(`评估未完成。${error.message}`, true);
      } finally {
        evaluating = false;
        renderControls();
      }
    }, 30);
  }

  function activate(view) {
    $('practice').hidden = view !== 'practice';
    $('ai').hidden = view !== 'ai';
    for (const link of document.querySelectorAll('[data-view]')) {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  for (const link of document.querySelectorAll('[data-view]')) {
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      activate(link.dataset.view);
      history.replaceState(null, '', link.getAttribute('href'));
    });
  }
  window.addEventListener('hashchange', () => activate(location.hash === '#ai' ? 'ai' : 'practice'));
  $('training-loss').value = lossRule;
  $('training-loss').addEventListener('change', () => {
    lossRule = $('training-loss').value;
    $('evaluation-results').replaceChildren();
    progress(0, 0, '准备就绪');
    status('已切换结算假设。两种模型分别保存。');
    save();
    renderControls();
  });
  $('training-players').addEventListener('change', () => $('evaluation-results').replaceChildren());
  $('train-start').addEventListener('click', startTraining);
  $('train-stop').addEventListener('click', () => stopTraining('已暂停'));
  $('evaluate').addEventListener('click', evaluate);
  $('train-reset').addEventListener('click', () => {
    resetDialog.returnValue = 'cancel';
    resetDialog.showModal();
  });
  resetDialog.addEventListener('close', () => {
    if (resetDialog.returnValue !== 'confirm') return;
    delete models[lossRule];
    $('evaluation-results').replaceChildren();
    progress(0, 0, '准备就绪');
    status('当前结算假设的模型已清除。');
    save();
    renderControls();
  });

  BlackjackPractice.mount($('practice'), {
    getModel: (rule) => models[rule]?.rounds ? models[rule] : null,
    getLossRule: () => lossRule,
  });
  save();
  renderControls();
  activate(location.hash === '#ai' ? 'ai' : 'practice');
})();
