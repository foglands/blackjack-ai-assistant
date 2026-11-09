# Blackjack AI Assistant

A local blackjack simulator and computer-vision lab for studying decision-making under uncertainty. The project combines a virtual table, Monte Carlo action estimates, a tabular reinforcement-learning trainer, and tools for recognizing card ranks in practice recordings or a selected desktop window. The core application is written in JavaScript with HTML and CSS. A C# WinForms host provides native window capture on Windows.

## Run the browser app

Run the following from the repository root. The browser app has no npm dependencies or build step.

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory dist
```

| Page | Use |
| --- | --- |
| [`/trainer.html`](http://127.0.0.1:8000/trainer.html) | Play with virtual chips, review decisions, or train and compare policies. |
| [`/index.html`](http://127.0.0.1:8000/index.html) | Enter a table state by hand and compare expected returns for legal actions. |
| [`/recognition.html`](http://127.0.0.1:8000/recognition.html) | Select a local video and step through recognized card events. |
| [`/glyph-training.html`](http://127.0.0.1:8000/glyph-training.html) | Label or review rank samples and manage the local template bank. |
| [`/live.html`](http://127.0.0.1:8000/live.html) | Use the observer and manual ledger. Compatible browsers can share a selected window after permission is granted. The Windows host offers native capture. |

The interface is primarily in Chinese. To try the replay tool, first generate the procedural test video using the command in [Validation and experiments](#validation-and-experiments). Then choose the generated video in the file picker. Its seat and card coordinates follow the reference layout. Choose the Classic reference and start at zero to inspect the first round.

## How it works

| Layer | Implementation |
| --- | --- |
| Game and simulation | `dist/table-state.js` manages the table state. `dist/engine.js` models shoe composition, legal actions, dealer play and payouts. The manual adviser samples 30,000 rollouts per available action and reports estimated returns with uncertainty. |
| Practice and policy learning | `dist/practice.js`, `dist/trainer.js` and `dist/training-engine.js` connect virtual play, decision feedback and the eight-deck simulator. The trainer runs tabular Q-learning and compares learned policies with basic strategy and count-based deviations. |
| Vision | `dist/recognition-engine.js` extracts rank glyphs from calibrated card regions, normalizes them, compares them with templates, and uses temporal confirmation before emitting card events. Strict thresholds and score margins allow it to abstain. The experimental public fallback uses additional confirmation before a match is accepted. |
| Observation and correction | `dist/live-capture.js` maps input frames to the expected geometry. The layout tools support custom card regions. `dist/observer-core.js` records accepted card events and manual corrections, then updates the observed rank inventory and estimates. |
| Windows capture | `desktop/BlackjackLab.cs` hosts local pages in WebView2. It captures a user-selected window with Win32 and shares read-only BGRA frames with JavaScript. Capture pauses or is invalidated when the source state or geometry prevents a reliable read. |

### Practice and policy training

Practice mode lets you play simulated hands and compare your choices against estimated returns. The policy trainer learns from batches of simulated hands, with up to 200,000 hands in one batch. Its state includes the dealer upcard, the player hand total and soft-ace or pair state, the hand stage, and a binned true count. An epsilon-greedy policy explores legal actions and updates action values from simulated outcomes. Basic strategy provides a baseline and a fallback where the learned table has insufficient evidence.

Policy comparisons use seeded simulations and report return per initial bet and win, loss and push rates. Payoff assumptions and trained state are kept separately in browser storage. An estimated return is specific to the selected rules, data and seeds. Treat small differences as hypotheses for further testing.

### Rank recognition and glyph training

The recognition trainer is a separate workflow. Choose a local recording, freeze a frame, select a rank crop, apply any perspective correction, and verify the label before saving it to the local bank. Use the replay and observer views to inspect recognized cards and correct incorrect or missing events. For a new layout, define the table crop and mark actual seat and card positions before relying on recognition.

The JavaScript tools can also learn templates from labelled frames and evaluate them on a separate recording. The held-out evaluator compares predicted card positions and ranks with annotations and rejects a video hash already recorded as a training input. The project uses template matching for vision and tabular reinforcement learning for the decision policy.

## Windows desktop build

Use Windows x64, PowerShell, the x64 .NET Framework C# compiler and the Microsoft Edge WebView2 Runtime. Prepare a WebView2 SDK directory containing `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, and `runtimes/win-x64/native/WebView2Loader.dll`. Supply your own SDK and runtime.

```powershell
.\desktop\build.ps1 -SdkDirectory 'C:\path\to\prepared-webview2-sdk'
.\desktop\BlackjackLab.exe
```

Keep `dist/` and `desktop/` next to each other. The build script looks for the x64 compiler under the Windows directory and can locate a compatible local SDK in a Teams add-in installation if you omit the SDK path.

## Validation and experiments

Use Node.js 22 or newer for the CLI utilities. Put FFmpeg and ffprobe on your PATH for video tests, or replace the values below with paths to the executables.

```sh
node recognition/simulate-seats.js
node recognition/simulate-layouts.js
node recognition/train-public-glyphs.js
```

The first two scripts exercise synthetic seat occupancy, coordinate mappings, frame confirmation and manual corrections. The video script learns from the earlier rounds of the procedural fixture and reports baseline and trained performance on the final round, including misses and false detections. The public-sample script reports separate results for held-out designs, photographed samples and non-rank negatives.

The import uses an attributed public reference bank and a synthetic video. The retained geometry is a starting point for calibration. Expect lower coverage on a new layout or card design until representative labels are added and independently evaluated.

| Check on the included source | Observed result |
| --- | --- |
| Synthetic seat occupancy | 1,023 of 1,023 expected events across 128 configurations, with zero false events or duplicates. Varied-rank stress detected 991 of 1,023, with zero false events or duplicates. |
| Layout integration | Passed landscape and nine-seat portrait mappings at two resolutions, including fallback confirmation and dealer-hole handling. |
| Procedural video | 787 frames and 12 supported positions in the final round. The baseline and calibrated run each matched six. The baseline had zero false detections and the calibrated run had one. One dealer position was outside the supported layout. |
| Public glyph evaluation | The fallback recognized 108 of 208 same-design, 52 of 104 unseen-design and 50 of 104 photographed hold-out examples, with zero wrong classifications on these sets. It rejected all 60 non-rank negatives. |
| Game and training smoke check | Trained 1,000 hands and verified that a 1,000-hand evaluation reproduced the same results with a fixed seed. |

Generate the procedural video and truth file locally using Python with Pillow, the Arial fonts available locally, and FFmpeg built with `libvpx-vp9`.

```sh
python -m pip install Pillow
python recognition/generate-synthetic.py --node node --ffmpeg ffmpeg
node recognition/simulate-video.js --ffmpeg ffmpeg --ffprobe ffprobe
```

For personal data, create a local layout JSON from the bundled reference and adjust its card positions for your own recording. The CLI expects dimensions, slots and templates in the layout. Use the bundled truth file as an example for timestamped rank annotations. Keep training and evaluation recordings independent.

```sh
node -e "require('node:fs').writeFileSync('layout.local.json', JSON.stringify(require('./dist/recognition-profile'), null, 2))"
node recognition/train-video.js --video train.webm --truth train-labels.local.json --profile layout.local.json --output trained-layout.local.json
node recognition/evaluate-heldout.js --video heldout.webm --profile trained-layout.local.json --truth heldout-labels.local.json
```

## Development roadmap

- Expand the labelled test set across camera angles, scale, lighting, overlapping cards and different table layouts. Track precision, recall, abstention rate and latency by layout and position.
- Make layout calibration easier and improve recovery when a window is resized, moved or partly covered. Keep the manual correction path available for uncertain reads.
- Compare policies across more independent seeds, report uncertainty around estimated returns and expand the set of configurable table rules.
- Add repeatable CI checks for the simulator and recognition pipeline and a versioned export format for layouts and training data.

The simulator is for education and experimentation with virtual chips. Observation is read-only and does not place bets or control other applications. Recordings, local glyphs and trained browser profiles stay on the machine. See [Third-party notices](THIRD_PARTY_NOTICES.md) for the origins of the shipped public glyph data.
