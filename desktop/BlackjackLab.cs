using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle(BlackjackLab.Title)]
[assembly: AssemblyProduct(BlackjackLab.Title)]

internal static class BlackjackLab
{
    internal const string Title = "PP专属21点测试";

    [STAThread]
    private static void Main()
    {
        WindowCapture.UsePhysicalPixels();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        try
        {
            Application.Run(new TrainerWindow(AppDomain.CurrentDomain.BaseDirectory));
        }
        catch (Exception error)
        {
            MessageBox.Show("无法启动" + Title + "。请确认程序文件齐全，并且已安装 Microsoft Edge WebView2 Runtime。\n\n" + error.Message,
                Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

internal sealed class TrainerWindow : Form
{
    private const string AppHost = "blackjack.local";
    private const string AppBlobPrefix = "blob:https://" + AppHost + "/";
    private const string ReplayCsvName = "blackjack-recognition.csv";
    private const string RulesUrl = "https://portail.assets.lotoquebec.com/ressources/assets/v3/assets/blt8296e79a7001648c/blt7a444d5d164b7f61/6470e86bb851cf1d70e69f21/Blackjack-en.pdf";
    private readonly string assets;
    private readonly string profile;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly Stopwatch captureClock = Stopwatch.StartNew();
    private WindowCapture captureTarget;
    private int captureGeneration;
    private bool captureInFlight;
    private bool choosingWindow;
    private long lastFrameStarted;

    internal TrainerWindow(string executableDirectory)
    {
        assets = Path.GetFullPath(Path.Combine(executableDirectory, "..", "dist"));
        profile = Path.Combine(executableDirectory, "user-data");
        Text = BlackjackLab.Title;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1280, 900);
        MinimumSize = new Size(600, 460);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(13, 22, 20);
        Shown += LoadTrainer;
    }

    private async void LoadTrainer(object sender, EventArgs args)
    {
        try
        {
            string entry = File.Exists(Path.Combine(assets, "trainer.html")) ? "trainer.html" : "index.html";
            if (!File.Exists(Path.Combine(assets, entry)))
                throw new FileNotFoundException("找不到牌桌资源。请将 desktop 和 dist 文件夹保留在同一个目录下。");

            Directory.CreateDirectory(profile);
            var options = new CoreWebView2EnvironmentOptions("--disable-background-networking");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile, options);
            if (IsDisposed) return;

            var view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor, AllowExternalDrop = false };
            Controls.Add(view);
            await view.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;

            var web = view.CoreWebView2;
            web.Settings.AreDefaultContextMenusEnabled = false;
            web.Settings.AreDevToolsEnabled = false;
            web.Settings.IsStatusBarEnabled = false;
            web.Settings.IsWebMessageEnabled = true;
            web.WebMessageReceived += OnCaptureMessage;
            web.NavigationStarting += OnNavigationStarting;
            web.NewWindowRequested += OnNewWindowRequested;
            web.ScreenCaptureStarting += (source, request) =>
            {
                var frame = request.OriginalSourceFrameInfo;
                request.Cancel = frame == null || !IsLivePage(frame.Source) || !IsLivePage(web.Source);
            };
            web.PermissionRequested += (source, request) => request.State = CoreWebView2PermissionState.Deny;
            web.DownloadStarting += OnDownloadStarting;
            web.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
            web.WebResourceRequested += (source, request) =>
            {
                string address = request.Request.Uri;
                bool localVideo = request.ResourceContext == CoreWebView2WebResourceContext.Media && IsAppBlobUri(address);
                if (!IsAppUri(address) && !localVideo)
                    request.Response = environment.CreateWebResourceResponse(null, 403, "Offline", "Content-Type: text/plain");
            };

            web.SetVirtualHostNameToFolderMapping(AppHost, assets, CoreWebView2HostResourceAccessKind.Deny);
            web.Navigate("https://" + AppHost + "/" + entry);
        }
        catch (Exception error)
        {
            if (IsDisposed) return;
            MessageBox.Show(this, "无法加载本地牌桌。请确认程序文件齐全、desktop 文件夹可写，并且已安装 Microsoft Edge WebView2 Runtime。\n\n" + error.Message,
                BlackjackLab.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private static bool IsAppUri(string address)
    {
        Uri uri;
        return Uri.TryCreate(address, UriKind.Absolute, out uri)
            && uri.Scheme == Uri.UriSchemeHttps && uri.Host == AppHost && uri.IsDefaultPort;
    }

    private static bool IsAppBlobUri(string address)
    {
        Guid id;
        return address != null && address.StartsWith(AppBlobPrefix, StringComparison.Ordinal)
            && Guid.TryParseExact(address.Substring(AppBlobPrefix.Length), "D", out id);
    }

    private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs args)
    {
        var download = args.DownloadOperation;
        string mediaType = download.MimeType.Split(';')[0].Trim();
        args.Cancel = !IsAppBlobUri(download.Uri)
            || !string.Equals(mediaType, "text/csv", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetFileName(args.ResultFilePath), ReplayCsvName, StringComparison.Ordinal);
    }

    private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (IsAppUri(args.Uri))
        {
            StopCapture();
            return;
        }
        args.Cancel = true;
        OpenOfficialRules(args.Uri, args.IsUserInitiated);
    }

    private static bool IsLivePage(string address)
    {
        return IsAppUri(address) && new Uri(address).AbsolutePath == "/live.html";
    }

    private void OnCaptureMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        var web = (CoreWebView2)sender;
        if (!IsLivePage(args.Source) || !IsLivePage(web.Source)) return;

        Dictionary<string, object> command;
        try { command = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson); }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }
        object type;
        if (command == null || !command.TryGetValue("type", out type)) return;

        switch (type as string)
        {
            case "capture:choose":
                if (choosingWindow) return;
                choosingWindow = true;
                StopCapture();
                int generation = captureGeneration;
                BeginInvoke(new Action(() => ChooseCaptureWindow(web, generation)));
                break;
            case "capture:frame":
                SendCaptureFrame(web);
                break;
            case "capture:stop":
                StopCapture();
                CaptureStatus(web, "stopped", "已停止窗口识牌。");
                break;
        }
    }

    private void ChooseCaptureWindow(CoreWebView2 web, int generation)
    {
        try
        {
            if (IsDisposed || generation != captureGeneration || !IsLivePage(web.Source)) return;
            var selected = WindowCapture.Choose(this);
            if (IsDisposed || generation != captureGeneration || !IsLivePage(web.Source)) return;
            if (selected == null)
            {
                CaptureStatus(web, "cancelled", "没有选择窗口。");
                return;
            }

            captureTarget = selected;
            web.PostWebMessageAsJson(json.Serialize(new {
                type = "capture:ready", title = selected.Title,
                width = selected.Width, height = selected.Height
            }));
        }
        catch (Exception error)
        {
            if (!IsDisposed) CaptureStatus(web, "error", "无法选择窗口。" + error.Message);
        }
        finally { choosingWindow = false; }
    }

    private async void SendCaptureFrame(CoreWebView2 web)
    {
        if (captureTarget == null)
        {
            CaptureStatus(web, "stopped", "请先选择识牌窗口。");
            return;
        }
        if (captureInFlight)
        {
            CaptureStatus(web, "paused", "上一帧仍在读取，请稍后继续。");
            return;
        }
        var selected = captureTarget;
        int generation = captureGeneration;
        captureInFlight = true;
        try
        {
            long wait = 34 - (captureClock.ElapsedMilliseconds - lastFrameStarted);
            if (wait > 0) await Task.Delay((int)wait);
            if (generation != captureGeneration || IsDisposed) return;
            lastFrameStarted = captureClock.ElapsedMilliseconds;
            using (var buffer = web.Environment.CreateSharedBuffer((ulong)selected.ByteCount))
            {
                IntPtr destination = buffer.Buffer;
                var result = await Task.Run(() => selected.ReadFrame(destination));
                if (generation != captureGeneration || IsDisposed) return;
                if (result.State != null)
                {
                    if (result.State == "stopped") StopCapture();
                    CaptureStatus(web, result.State, result.Message);
                    return;
                }

                web.PostSharedBufferToScript(buffer, CoreWebView2SharedBufferAccess.ReadOnly, json.Serialize(new {
                    type = "capture:frame", width = selected.Width, height = selected.Height,
                    pixelFormat = "BGRA", capturedAtMs = result.Timestamp, captureMs = result.ElapsedMilliseconds
                }));
            }
        }
        catch (Exception error)
        {
            if (!IsDisposed && generation == captureGeneration)
            {
                StopCapture();
                CaptureStatus(web, "error", "无法读取窗口画面。" + error.Message);
            }
        }
        finally { captureInFlight = false; }
    }

    private void StopCapture()
    {
        captureTarget = null;
        captureGeneration += 1;
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        StopCapture();
        base.OnFormClosed(args);
    }

    private void CaptureStatus(CoreWebView2 web, string state, string message)
    {
        if (!IsDisposed && IsLivePage(web.Source))
            web.PostWebMessageAsJson(json.Serialize(new { type = "capture:status", state = state, message = message }));
    }

    private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        OpenOfficialRules(args.Uri, args.IsUserInitiated);
    }

    private void OpenOfficialRules(string address, bool userInitiated)
    {
        if (!userInitiated || address != RulesUrl) return;

        try
        {
            Process.Start(new ProcessStartInfo(RulesUrl) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show(this, "无法在默认浏览器中打开官方规则。\n\n" + error.Message,
                BlackjackLab.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
}

internal sealed class WindowCapture
{
    private readonly IntPtr handle;
    private readonly uint processId;
    private readonly uint threadId;
    internal string Title { get; private set; }
    internal int Width { get; private set; }
    internal int Height { get; private set; }
    internal int ByteCount { get { return Width * Height * 4; } }

    private WindowCapture(IntPtr handle, string title, Rectangle bounds, uint process, uint thread)
    {
        this.handle = handle;
        processId = process;
        threadId = thread;
        Title = title;
        Width = bounds.Width;
        Height = bounds.Height;
    }

    public override string ToString() { return Title; }

    internal static void UsePhysicalPixels()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { }
    }

    internal static WindowCapture Choose(Form owner)
    {
        var windows = new List<WindowCapture>();
        uint ownProcess = (uint)Process.GetCurrentProcess().Id;
        EnumWindows((window, data) =>
        {
            uint process;
            uint thread = GetWindowThreadProcessId(window, out process);
            if (process == ownProcess || GetWindow(window, 4) != IntPtr.Zero || !IsAvailable(window)) return true;
            var title = new StringBuilder(512);
            if (GetWindowText(window, title, title.Capacity) == 0) return true;
            Rectangle bounds;
            if (TryClientBounds(window, out bounds) && bounds.Width >= 64 && bounds.Height >= 64
                && (long)bounds.Width * bounds.Height <= 10000000)
                windows.Add(new WindowCapture(window, title.ToString(), bounds, process, thread));
            return true;
        }, IntPtr.Zero);
        windows.Sort((left, right) => StringComparer.CurrentCultureIgnoreCase.Compare(left.Title, right.Title));

        using (var dialog = new Form { Text = "选择一个识牌窗口", StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog, ClientSize = new Size(560, 290),
            MinimizeBox = false, MaximizeBox = false, ShowInTaskbar = false, AutoScaleMode = AutoScaleMode.Dpi })
        {
            var info = new Label { Text = "选择要读取的窗口。请保持该窗口可见且不被遮挡。",
                Location = new Point(12, 12), Size = new Size(536, 30) };
            var list = new ListBox { Location = new Point(12, 43), Size = new Size(536, 194), HorizontalScrollbar = true };
            foreach (var window in windows) list.Items.Add(window);
            if (windows.Count == 0) info.Text = "没有找到可读取的窗口。请先打开目标窗口，再重新选择。";
            var choose = new Button { Text = "读取此窗口", DialogResult = DialogResult.OK,
                Location = new Point(348, 247), Size = new Size(105, 30), Enabled = false };
            var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel,
                Location = new Point(464, 247), Size = new Size(84, 30) };
            list.SelectedIndexChanged += (source, args) => choose.Enabled = list.SelectedItem is WindowCapture;
            dialog.Controls.AddRange(new Control[] { info, list, choose, cancel });
            dialog.AcceptButton = choose;
            dialog.CancelButton = cancel;
            return dialog.ShowDialog(owner) == DialogResult.OK ? list.SelectedItem as WindowCapture : null;
        }
    }

    internal sealed class Result
    {
        internal string State;
        internal string Message;
        internal long Timestamp;
        internal double ElapsedMilliseconds;
    }

    internal Result ReadFrame(IntPtr destination)
    {
        uint process;
        if (GetWindowThreadProcessId(handle, out process) != threadId || process != processId)
            return Status("stopped", "目标窗口已关闭。请重新选择窗口。");
        Rectangle bounds;
        if (!IsAvailable(handle) || !TryClientBounds(handle, out bounds))
            return Status("paused", "目标窗口已隐藏或最小化。恢复窗口后再继续。");
        if (bounds.Width != Width || bounds.Height != Height)
            return Status("stopped", "目标窗口的尺寸已变化。请调整到原来的布局后重新选择。");
        uint affinity;
        if (GetWindowDisplayAffinity(handle, out affinity) && affinity != 0)
            return Status("stopped", "此窗口禁止捕获。");
        if (IsCovered(handle, bounds))
            return Status("paused", "目标窗口被遮挡。请移开覆盖它的窗口后再继续。");

        var started = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var timer = Stopwatch.StartNew();
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return Status("paused", "无法建立窗口画面缓冲区。");
        IntPtr bitmap = IntPtr.Zero;
        IntPtr previous = IntPtr.Zero;
        try
        {
            var info = new BitmapInfo { Size = (uint)Marshal.SizeOf(typeof(BitmapInfo)), Width = Width,
                Height = -Height, Planes = 1, BitsPerPixel = 32 };
            IntPtr pixels;
            bitmap = CreateDIBSection(dc, ref info, 0, out pixels, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero || pixels == IntPtr.Zero) return Status("paused", "无法建立窗口画面缓冲区。");
            previous = SelectObject(dc, bitmap);
            if (previous == IntPtr.Zero || previous == new IntPtr(-1)) return Status("paused", "无法读取窗口像素。");
            PatBlt(dc, 0, 0, Width, Height, 0x00000042);
            // Ask the chosen window for its client pixels. Never copy the desktop.
            if (!PrintWindow(handle, dc, 3) || !HasDetail(pixels))
            {
                PatBlt(dc, 0, 0, Width, Height, 0x00000042);
                if (!PrintWindow(handle, dc, 1) || !HasDetail(pixels))
                    return Status("paused", "目标窗口没有提供可读画面。请保持其可见，并使用支持窗口捕获的程序。");
            }
            if (!IsAvailable(handle) || GetWindowThreadProcessId(handle, out process) != threadId || process != processId)
                return Status("paused", "目标窗口已离开可读取状态。");
            Rectangle updatedBounds;
            if (!TryClientBounds(handle, out updatedBounds) || updatedBounds.Size != bounds.Size)
                return Status("stopped", "目标窗口的尺寸已变化。请调整到原来的布局后重新选择。");
            if (IsCovered(handle, updatedBounds))
                return Status("paused", "目标窗口被遮挡。请移开覆盖它的窗口后再继续。");
            CopyMemory(destination, pixels, new UIntPtr((uint)ByteCount));
            return new Result { Timestamp = started, ElapsedMilliseconds = timer.Elapsed.TotalMilliseconds };
        }
        finally
        {
            if (previous != IntPtr.Zero && previous != new IntPtr(-1)) SelectObject(dc, previous);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            DeleteDC(dc);
        }
    }

    private bool HasDetail(IntPtr pixels)
    {
        int first = Marshal.ReadInt32(pixels, (Height / 8 * Width + Width / 8) * 4) & 0xffffff;
        for (int y = 1; y <= 7; y++)
            for (int x = 1; x <= 7; x++)
                if ((Marshal.ReadInt32(pixels, (Height * y / 8 * Width + Width * x / 8) * 4) & 0xffffff) != first)
                    return true;
        return false;
    }

    private static Result Status(string state, string message) { return new Result { State = state, Message = message }; }

    private static bool IsAvailable(IntPtr window)
    {
        return IsVisible(window) && !IsHungAppWindow(window);
    }

    private static bool IsVisible(IntPtr window)
    {
        int cloaked;
        return IsWindowVisible(window) && !IsIconic(window)
            && (GetCloaked(window, 14, out cloaked, 4) != 0 || cloaked == 0);
    }

    private static bool IsCovered(IntPtr window, Rectangle bounds)
    {
        // Walk only windows above the target in the desktop z-order.
        IntPtr above = GetWindow(window, 3);
        for (int checkedCount = 0; above != IntPtr.Zero && checkedCount < 1024; checkedCount++, above = GetWindow(above, 3))
        {
            if (!IsVisible(above)) continue;
            NativeRect rect;
            if (GetFrame(above, 9, out rect, 16) != 0 && !GetWindowRect(above, out rect)) continue;
            if (bounds.IntersectsWith(Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom))) return true;
        }
        return false;
    }

    private static bool TryClientBounds(IntPtr window, out Rectangle bounds)
    {
        bounds = Rectangle.Empty;
        NativeRect rect;
        var origin = new NativePoint();
        if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref origin)) return false;
        bounds = new Rectangle(origin.X, origin.Y, rect.Right, rect.Bottom);
        return bounds.Width > 0 && bounds.Height > 0;
    }

    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitsPerPixel;
        public uint Compression, ImageSize;
        public int PixelsPerMeterX, PixelsPerMeterY;
        public uint ColorsUsed, ColorsImportant;
    }

    private delegate bool EnumerateWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumerateWindow callback, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsHungAppWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out NativeRect rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int GetCloaked(IntPtr window, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int GetFrame(IntPtr window, int attribute, out NativeRect value, int size);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr pixels, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr item);
    [DllImport("gdi32.dll")] private static extern bool PatBlt(IntPtr dc, int x, int y, int width, int height, uint operation);
    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")] private static extern void CopyMemory(IntPtr destination, IntPtr source, UIntPtr length);
}
