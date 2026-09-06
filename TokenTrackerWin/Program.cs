namespace TokenTrackerWin;

internal static class Program
{
    // Stable per-user mutex name so a second launch just exits.
    private const string SingleInstanceMutexName = "TokenTracker.Windows.Tray.SingleInstance";

    [STAThread]
    private static void Main(string[] args)
    {
        InstallExceptionGuards();

        // Windows launches us with the full tokentracker://… URL as an argument when a
        // deep link fires (OAuth callback). Extract it if present.
        var deepLink = FindDeepLink(args);
        var launchedAtStartup = args.Any(a =>
            string.Equals(a, LaunchAtStartup.StartupArgument, StringComparison.OrdinalIgnoreCase));
        // Silent Start (persisted toggle) OR the --startup tag: launches stay in the tray.
        var silentEffective = SilentStart.Enabled || launchedAtStartup;
        Diag.Log("program", $"Main argc={args.Length} deepLink={(deepLink ?? "<none>")} startup={launchedAtStartup} silent={silentEffective}");

        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var isNew);
        Diag.Log("program", $"mutex isNew={isNew}");
        if (!isNew)
        {
            // Already running: if launched to handle a deep link, hand it to the live
            // instance. Either way a second copy must exit (single-instance app).
            // A --startup second instance (duplicate login item) stays quiet — no "show".
            if (deepLink is not null)
            {
                var ok = SingleInstance.TryForwardToPrimary(deepLink);
                Diag.Log("program", $"forwarded deepLink to primary: {ok}");
            }
            else if (!launchedAtStartup)
            {
                var shown = SingleInstance.TryForwardToPrimary("show");
                Diag.Log("program", $"forwarded show to primary: {shown}");
            }
            return;
        }

        // Primary instance: make tokentracker:// point at this exe so the OAuth callback
        // (in the system browser) can deep-link the code back to us.
        UrlProtocol.EnsureRegistered();

        // A WPF Application instance gives the (WPF) dashboard window its resource /
        // dispatcher context. We never call its Run(); the WinForms message pump below
        // drives the shared STA thread (and the WPF Dispatcher rides on it). Explicit
        // shutdown mode so WPF doesn't tear itself down when the window is hidden.
        var wpfApp = new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };
        TrayApplicationContext? trayContext = null;
        wpfApp.DispatcherUnhandledException += (_, e) =>
        {
            var shuttingDown = wpfApp.Dispatcher.HasShutdownStarted || wpfApp.Dispatcher.HasShutdownFinished;
            var recovery = DispatcherExceptionPolicy.Classify(e.Exception, shuttingDown);
            if (recovery == DispatcherExceptionPolicy.RecoveryKind.IgnoreAfterShutdown
                || recovery == DispatcherExceptionPolicy.RecoveryKind.IgnoreCancellation)
            {
                Diag.Log("program", $"WPF dispatcher exception absorbed during window teardown: {e.Exception}");
                // These callbacks have no useful work left after cancellation or
                // dispatcher teardown, so allowing WPF to continue is intentional.
                e.Handled = true;
                return;
            }

            if (recovery == DispatcherExceptionPolicy.RecoveryKind.RecreateDashboardWebView
                && trayContext?.RecoverDashboardWebView(e.Exception) == true)
            {
                Diag.Log("program", $"WPF dispatcher exception recovered by recreating WebView2: {e.Exception}");
                e.Handled = true;
                return;
            }

            // Do not turn an unknown dispatcher failure into a silently-running
            // but corrupted tray process. Leaving Handled=false preserves WPF's
            // normal shutdown path after the diagnostic has been recorded.
            Diag.Log("program", $"WPF dispatcher exception unhandled: {e.Exception}");
        };

        ApplicationConfiguration.Initialize();
        // Show the desktop pet on a normal launch (manual run or post-install), but stay
        // quietly in the tray when Windows auto-starts us at login, when we were only
        // spun up to relay an OAuth deep link, or when Silent Start is enabled (no pet,
        // no dashboard — regardless of the pet's stored visibility). The dashboard no
        // longer auto-opens — the pet is the visible presence.
        var showPetOnLaunch = deepLink is null && !launchedAtStartup;
        var ctx = new TrayApplicationContext(showPetOnLaunch, silentEffective);
        trayContext = ctx;

        // Listen for deep links forwarded by secondary launches. "show" (a bare second
        // launch — user intent) surfaces the dashboard; OpenDashboard marshals itself
        // onto the UI thread because this callback arrives on a pipe thread.
        using var listenerCts = new CancellationTokenSource();
        SingleInstance.StartListener(payload =>
        {
            if (payload == "show") { ctx.OpenDashboard(); }
            else { ctx.HandleDeepLink(payload); }
        }, listenerCts.Token);

        // Cold start via a deep link (app wasn't already running): handle it once ready.
        if (deepLink is not null) ctx.HandleDeepLink(deepLink);

        Application.Run(ctx);

        listenerCts.Cancel();
        GC.KeepAlive(mutex);
    }

    private static void InstallExceptionGuards()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Diag.Log("program", $"unhandled exception terminating={e.IsTerminating}: {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Diag.Log("program", $"unobserved task exception: {e.Exception}");
            e.SetObserved();
        };
        System.Windows.Forms.Application.SetUnhandledExceptionMode(
            System.Windows.Forms.UnhandledExceptionMode.CatchException);
        System.Windows.Forms.Application.ThreadException += (_, e) =>
            Diag.Log("program", $"WinForms UI exception: {e}");
    }

    private static string? FindDeepLink(string[] args)
    {
        foreach (var a in args)
        {
            if (a.StartsWith(UrlProtocol.Scheme + "://", StringComparison.OrdinalIgnoreCase))
                return a;
        }
        return null;
    }
}
