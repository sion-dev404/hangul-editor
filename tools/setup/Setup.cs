// 한글 편집기 설치 · 지우기 프로그램 (우리 디자인, WPF)
// 같은 소스를 두 번 컴파일한다: /define:SETUP → 설치 프로그램(프로그램 묶음 payload.zip을 품음), /define:UNINSTALL → 지우기 프로그램
// 빌드: node tools/make-setup.mjs  (Windows 기본 .NET Framework 4의 csc.exe만 쓴다)
// 명령줄: /S(창 없이) --dir=경로 --no-desktop --no-launch   (지우기: /S --purge)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace HangulEditorSetup
{
    static class Info
    {
        public const string AppName = "한글 편집기";
        public const string ExeName = "한글 편집기.exe";
        public const string UninstName = "Uninstall 한글 편집기.exe";
        public const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.sion-dev404.hangul-editor";
        public const string Publisher = "sion-dev404";
        public static string DefaultDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "hangul-editor"); } }
        public static string UserData { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "hangul-editor"); } }
        public static string Desktop { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"); } }
        public static string StartMenu { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"); } }
    }

    public class App
    {
        [STAThread]
        public static int Main(string[] args)
        {
            var opt = new Options(args);
#if UNINSTALL
            // 설치 폴더 안에서 실행되면 임시 폴더로 자신을 복사해 다시 실행한다(폴더를 통째로 지우기 위해)
            string self = Assembly.GetExecutingAssembly().Location;
            if (opt.Target == null)
            {
                string dir = Path.GetDirectoryName(self);
                string tmp = Path.Combine(Path.GetTempPath(), "hangul-editor-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                File.Copy(self, tmp, true);
                var psi = new ProcessStartInfo(tmp, (opt.Silent ? "/S " : "") + (opt.Purge ? "--purge " : "") + (opt.Test ? "--test " : "") + "--target=\"" + dir + "\"") { UseShellExecute = false };
                Process.Start(psi);
                return 0;
            }
#endif
            if (opt.Silent)
            {
                try { new Work(opt, null).Run(); return 0; }
                catch (Exception e) { try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "hangul-editor-setup-error.txt"), e.ToString()); } catch { } return 1; }
            }
            var app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            var ui = new Ui(opt);
            if (opt.Snap != null) { ui.Snapshots(opt.Snap); return 0; }
            app.Run(ui.Window);
            return 0;
        }
    }

    public class Options
    {
        public bool Silent, NoDesktop, NoLaunch, Purge, Test; // Test: 파일만 풀고 이전 판·바로가기·등록은 건드리지 않음(점검용)
        public string Dir, Target, Snap; // Snap: 화면을 띄우지 않고 각 단계를 그림으로만 뽑는다(점검용)
        public Options(string[] args)
        {
            foreach (var a in args)
            {
                if (a == "/S" || a == "--silent") Silent = true;
                else if (a == "--no-desktop") NoDesktop = true;
                else if (a == "--no-launch") NoLaunch = true;
                else if (a == "--purge") Purge = true;
                else if (a == "--test") Test = true;
                else if (a.StartsWith("--dir=")) Dir = a.Substring(6).Trim('"');
                else if (a.StartsWith("--target=")) Target = a.Substring(9).Trim('"');
                else if (a.StartsWith("--snap=")) Snap = a.Substring(7).Trim('"');
            }
        }
    }

    // ------------------------------------------------------------------
    // 실제 작업 (화면 없이도 돈다)
    // ------------------------------------------------------------------
    public class Work
    {
        readonly Options opt;
        readonly Action<double, string> report;
        public Work(Options o, Action<double, string> r) { opt = o; report = r ?? ((p, s) => { }); }

        public static string InstalledDir()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(Info.RegKey))
            {
                var v = k == null ? null : k.GetValue("InstallLocation") as string;
                return string.IsNullOrEmpty(v) ? null : v;
            }
        }
        public static string InstalledVersion()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(Info.RegKey))
                return k == null ? null : k.GetValue("DisplayVersion") as string;
        }

        // 예전 설치 마법사(electron-builder NSIS)로 깐 판: 제거 정보에서 찾는다
        public class OldInstall { public string Uninstaller, Dir, Version; public bool Machine; }
        public static List<OldInstall> FindOldInstalls()
        {
            var list = new List<OldInstall>();
            var roots = new[] {
                new { Hive = Registry.CurrentUser, Path = @"Software\Microsoft\Windows\CurrentVersion\Uninstall", Machine = false },
                new { Hive = Registry.LocalMachine, Path = @"Software\Microsoft\Windows\CurrentVersion\Uninstall", Machine = true },
                new { Hive = Registry.LocalMachine, Path = @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", Machine = true },
            };
            foreach (var r in roots)
            {
                try
                {
                    using (var k = r.Hive.OpenSubKey(r.Path))
                    {
                        if (k == null) continue;
                        foreach (var name in k.GetSubKeyNames())
                        {
                            using (var s = k.OpenSubKey(name))
                            {
                                if (s == null) continue;
                                var dn = s.GetValue("DisplayName") as string;
                                var us = s.GetValue("UninstallString") as string;
                                if (dn == null || us == null || !dn.StartsWith(Info.AppName)) continue;
                                if (us.IndexOf("Uninstall " + Info.AppName, StringComparison.OrdinalIgnoreCase) < 0) continue;
                                if (name == "io.github.sion-dev404.hangul-editor") continue; // 우리 새 설치
                                string exe = us.Trim();
                                if (exe.StartsWith("\"")) exe = exe.Substring(1, exe.IndexOf('"', 1) - 1);
                                else { int sp = exe.IndexOf(".exe", StringComparison.OrdinalIgnoreCase); if (sp > 0) exe = exe.Substring(0, sp + 4); }
                                if (!File.Exists(exe)) continue;
                                list.Add(new OldInstall { Uninstaller = exe, Dir = Path.GetDirectoryName(exe), Version = s.GetValue("DisplayVersion") as string, Machine = r.Machine });
                            }
                        }
                    }
                }
                catch { }
            }
            return list;
        }

        // 켜져 있는 한글 편집기 (설치 폴더 기준)
        public static List<Process> Running(IEnumerable<string> dirs)
        {
            var res = new List<Process>();
            var ds = dirs.Where(d => !string.IsNullOrEmpty(d)).Select(d => Path.GetFullPath(d).TrimEnd('\\') + "\\").ToList();
            foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Info.ExeName)))
            {
                string path = null;
                try { path = p.MainModule.FileName; } catch { }
                if (path == null || ds.Count == 0 || ds.Any(d => path.StartsWith(d, StringComparison.OrdinalIgnoreCase))) res.Add(p);
            }
            return res;
        }

        // 창 닫기를 부탁하고(저장 안 한 내용이 있으면 편집기가 묻는다) 기다린다
        public static bool CloseRunning(IEnumerable<string> dirs, int waitMs)
        {
            var ps = Running(dirs);
            foreach (var p in ps) { try { p.CloseMainWindow(); } catch { } }
            var until = DateTime.Now.AddMilliseconds(waitMs);
            while (DateTime.Now < until)
            {
                if (Running(dirs).Count == 0) return true;
                Thread.Sleep(300);
            }
            return Running(dirs).Count == 0;
        }

        public string TargetDir { get { return opt.Dir ?? InstalledDir() ?? Info.DefaultDir; } }

#if SETUP
        public void Run()
        {
            string dir = TargetDir;
            var olds = opt.Test ? new List<OldInstall>() : FindOldInstalls();
            var allDirs = new List<string> { dir };
            allDirs.AddRange(olds.Select(o => o.Dir));

            report(0.01, "준비하고 있어요");
            if (Running(allDirs).Count > 0 && !CloseRunning(allDirs, opt.Silent ? 10000 : 60000))
                throw new UserMessage("한글 편집기가 아직 켜져 있습니다.\n저장한 뒤 닫고 다시 시도해 주세요.");

            // 예전 마법사 판 정리 (컴퓨터 전체 설치였다면 관리자 확인 창이 한 번 뜬다)
            foreach (var o in olds)
            {
                report(0.03, "이전 버전(" + (o.Version ?? "") + ")을 정리하고 있어요" + (o.Machine ? " · 관리자 확인 창이 뜨면 '예'를 눌러 주세요" : ""));
                RemoveOld(o);
            }

            // 프로그램 파일 풀기
            report(0.05, "프로그램 파일을 복사하고 있어요");
            if (Directory.Exists(dir)) DeleteDir(dir, null);
            Directory.CreateDirectory(dir);
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                long total = zip.Entries.Sum(e => e.Length), done = 0;
                string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
                foreach (var e in zip.Entries)
                {
                    string dest = Path.GetFullPath(Path.Combine(dir, e.FullName));
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // 폴더 밖으로 나가는 이름은 무시
                    if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (var src = e.Open())
                    using (var dst = File.Create(dest))
                    {
                        var buf = new byte[1 << 20];
                        int n;
                        while ((n = src.Read(buf, 0, buf.Length)) > 0)
                        {
                            dst.Write(buf, 0, n);
                            done += n;
                            string what = e.FullName.Contains("fonts/kogl") ? "공공누리 글꼴을 넣고 있어요" : "프로그램 파일을 복사하고 있어요";
                            report(0.05 + 0.88 * done / Math.Max(1, total), what);
                        }
                    }
                }
            }

            if (opt.Test) { report(1, "점검 끝"); return; }
            report(0.95, "바로가기를 만들고 있어요");
            string exe = Path.Combine(dir, Info.ExeName);
            Shortcut(Info.StartMenu, exe, dir);
            if (!opt.NoDesktop) Shortcut(Info.Desktop, exe, dir);
            else if (File.Exists(Info.Desktop)) File.Delete(Info.Desktop);

            report(0.98, "마무리하고 있어요");
            Register(dir, exe);
            report(1, "설치가 끝났습니다");
        }

        static void RemoveOld(OldInstall o)
        {
            // NSIS 제거 프로그램은 _?=폴더 를 주면 그 자리에서 끝까지 실행되고 기다릴 수 있다
            string args = "/S _?=" + o.Dir;
            var psi = new ProcessStartInfo(o.Uninstaller, args) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden };
            if (o.Machine) psi.Verb = "runas";
            try
            {
                using (var p = Process.Start(psi)) { if (p != null) p.WaitForExit(120000); }
            }
            catch (System.ComponentModel.Win32Exception) { throw new UserMessage("이전 버전을 정리하려면 관리자 확인이 필요합니다. 다시 시도해 주세요."); }
            // 남은 제거 프로그램과 폴더 정리
            if (o.Machine)
            {
                try
                {
                    var del = new ProcessStartInfo("cmd.exe", "/c rmdir /s /q \"" + o.Dir + "\"") { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
                    using (var p = Process.Start(del)) { if (p != null) p.WaitForExit(30000); }
                }
                catch { }
            }
            else { try { DeleteDir(o.Dir, null); } catch { } }
        }

        static void Register(string dir, string exe)
        {
            long size = 0;
            try { size = new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024; } catch { }
            using (var k = Registry.CurrentUser.CreateSubKey(Info.RegKey))
            {
                string un = Path.Combine(dir, Info.UninstName);
                k.SetValue("DisplayName", Info.AppName);
                k.SetValue("DisplayVersion", BuildInfo.Version);
                k.SetValue("Publisher", Info.Publisher);
                k.SetValue("DisplayIcon", exe + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + un + "\"");
                k.SetValue("QuietUninstallString", "\"" + un + "\" /S");
                k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, size), RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
        }

        static void Shortcut(string lnk, string target, string workDir)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(lnk));
            var t = Type.GetTypeFromProgID("WScript.Shell");
            object sh = Activator.CreateInstance(t);
            object l = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { lnk });
            var lt = l.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, l, new object[] { target });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, l, new object[] { workDir });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, l, new object[] { target + ",0" });
            lt.InvokeMember("Description", BindingFlags.SetProperty, null, l, new object[] { "한글·워드 문서 편집기" });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, l, null);
        }
#endif

#if UNINSTALL
        public void Run()
        {
            string dir = opt.Target ?? InstalledDir() ?? Info.DefaultDir;
            report(0.02, "준비하고 있어요");
            if (Running(new[] { dir }).Count > 0 && !CloseRunning(new[] { dir }, opt.Silent ? 10000 : 60000))
                throw new UserMessage("한글 편집기가 아직 켜져 있습니다.\n저장한 뒤 닫고 다시 시도해 주세요.");
            report(0.05, "바로가기를 지우고 있어요");
            if (!opt.Test) foreach (var l in new[] { Info.Desktop, Info.StartMenu }) { try { if (File.Exists(l)) File.Delete(l); } catch { } }
            report(0.08, "프로그램 파일을 지우고 있어요");
            DeleteDir(dir, (p) => report(0.08 + 0.82 * p, "프로그램 파일을 지우고 있어요"));
            if (opt.Purge)
            {
                report(0.92, "설정과 자동 복구 자료를 지우고 있어요");
                try { DeleteDir(Info.UserData, null); } catch { }
            }
            if (!opt.Test) { try { Registry.CurrentUser.DeleteSubKeyTree(Info.RegKey, false); } catch { } }
            report(1, "지웠습니다");
            // 임시 폴더에 복사된 자기 자신은 끝난 뒤 지운다
            try
            {
                string self = Assembly.GetExecutingAssembly().Location;
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + self + "\"") { CreateNoWindow = true, UseShellExecute = false });
            }
            catch { }
        }
#endif

        public static void DeleteDir(string dir, Action<double> progress)
        {
            if (!Directory.Exists(dir)) return;
            var files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories);
            for (int i = 0; i < files.Length; i++)
            {
                for (int t = 0; ; t++)
                {
                    try { File.SetAttributes(files[i], FileAttributes.Normal); File.Delete(files[i]); break; }
                    catch (IOException) { if (t > 20) throw new UserMessage("파일을 지우지 못했습니다(사용 중): " + files[i]); Thread.Sleep(250); }
                    catch (UnauthorizedAccessException) { if (t > 20) throw new UserMessage("파일을 지울 권한이 없습니다: " + files[i]); Thread.Sleep(250); }
                }
                if (progress != null && (i % 25 == 0 || i == files.Length - 1)) progress((i + 1.0) / files.Length);
            }
            for (int t = 0; t < 20; t++)
            {
                try { Directory.Delete(dir, true); break; }
                catch { Thread.Sleep(250); }
            }
        }
    }

    public class UserMessage : Exception { public UserMessage(string m) : base(m) { } }

    // ------------------------------------------------------------------
    // 화면
    // ------------------------------------------------------------------
    public class Ui
    {
        public Window Window;
        readonly Options opt;
        FrameworkElement root;
        T F<T>(string n) where T : class { return root.FindName(n) as T; }

        const string Blue = "#2F6FD6";

        public Ui(Options o)
        {
            opt = o;
            root = (FrameworkElement)XamlReader.Parse(Xaml());
            Window = new Window
            {
                Title = Info.AppName + (IsSetup ? " 설치" : " 지우기"),
                Width = 760, Height = 470,
                WindowStyle = WindowStyle.None, AllowsTransparency = true, Background = Brushes.Transparent,
                ResizeMode = ResizeMode.NoResize, WindowStartupLocation = WindowStartupLocation.CenterScreen,
                Content = root, FontFamily = new FontFamily("Malgun Gothic"),
            };
            try
            {
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png"))
                {
                    var bi = new BitmapImage(); bi.BeginInit(); bi.StreamSource = s; bi.CacheOption = BitmapCacheOption.OnLoad; bi.EndInit(); bi.Freeze();
                    F<Image>("Logo").Source = bi; Window.Icon = bi;
                }
            }
            catch { }
            // 빈 곳을 끌면 창이 움직인다 (버튼·선택 항목 위에서는 움직이지 않는다)
            root.MouseLeftButtonDown += (s, e) =>
            {
                for (var d = e.OriginalSource as DependencyObject; d != null; d = VisualTreeHelper.GetParent(d) ?? LogicalTreeHelper.GetParent(d))
                {
                    var fe = d as FrameworkElement;
                    if (d is Button || (fe != null && fe.Cursor == Cursors.Hand)) return;
                }
                if (e.ButtonState == MouseButtonState.Pressed) { try { Window.DragMove(); } catch { } }
            };
            F<Button>("BtnClose").Click += (s, e) => { if (!busy) Window.Close(); };
            F<Button>("BtnMin").Click += (s, e) => Window.WindowState = WindowState.Minimized;
            F<TextBlock>("Ver").Text = "버전 " + BuildInfo.Version;
            Init();
        }

        static bool IsSetup
        {
            get
            {
#if SETUP
                return true;
#else
                return false;
#endif
            }
        }

        bool busy;
        string dir;
        bool desktop = true, purge = false;

        bool noAnim;
        public void Snapshots(string dir)
        {
            noAnim = true;
            Directory.CreateDirectory(dir);
            Action<string> save = (name) =>
            {
                root.Measure(new Size(Window.Width, Window.Height));
                root.Arrange(new Rect(0, 0, Window.Width, Window.Height));
                root.UpdateLayout();
                var rtb = new RenderTargetBitmap((int)(Window.Width * 1.5), (int)(Window.Height * 1.5), 144, 144, PixelFormats.Pbgra32);
                rtb.Render(root);
                var enc = new PngBitmapEncoder(); enc.Frames.Add(BitmapFrame.Create(rtb));
                using (var f = File.Create(Path.Combine(dir, name + ".png"))) enc.Save(f);
            };
            Show("PgStart"); save("1-start");
            Show("PgWork");
            F<TextBlock>("WorkHead").Text = IsSetup ? "설치하고 있어요" : "지우고 있어요";
            F<TextBlock>("Step").Text = IsSetup ? "공공누리 글꼴을 넣고 있어요" : "프로그램 파일을 지우고 있어요";
            F<TextBlock>("Pct").Text = "62%"; F<TextBlock>("Tip").Text = IsSetup ? tips[0] : "";
            root.Measure(new Size(Window.Width, Window.Height)); root.Arrange(new Rect(0, 0, Window.Width, Window.Height)); root.UpdateLayout();
            F<Border>("Fill").Width = F<Border>("Track").ActualWidth * 0.62;
            save("2-work");
            F<TextBlock>("DoneHead").Text = IsSetup ? "설치가 끝났습니다" : "지웠습니다";
            F<TextBlock>("DoneSub").Text = IsSetup ? "시작 메뉴와 바탕화면에 '한글 편집기'를 만들었습니다." : "한글 편집기를 써 주셔서 고맙습니다.";
            Show("PgDone"); save("3-done");
            F<TextBlock>("ErrText").Text = "한글 편집기가 아직 켜져 있습니다.\n저장한 뒤 닫고 다시 시도해 주세요.";
            Show("PgError"); save("4-error");
        }

        void Show(string page)
        {
            foreach (var n in new[] { "PgStart", "PgWork", "PgDone", "PgError" })
            {
                var el = F<FrameworkElement>(n);
                bool on = n == page;
                el.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
                if (on && noAnim) { el.Opacity = 1; el.RenderTransform = null; }
                else if (on)
                {
                    el.Opacity = 0;
                    el.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(260)));
                    var tt = new TranslateTransform(0, 10); el.RenderTransform = tt;
                    tt.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(10, 0, TimeSpan.FromMilliseconds(260)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
                }
            }
        }

        void Init()
        {
            var w = new Work(opt, null);
            dir = w.TargetDir;
            desktop = !opt.NoDesktop;
            purge = opt.Purge;
#if SETUP
            F<TextBlock>("Head").Text = "한글·워드 문서를 한 곳에서";
            F<TextBlock>("Sub").Text = "한컴·MS 오피스 없이 HWP · HWPX · DOCX를\n열고, 고치고, 서로 바꿉니다.";
            F<TextBlock>("Feat1").Text = "한글 · 워드 편집과 서로 변환";
            F<TextBlock>("Feat2").Text = "15초마다 자동 복구 — 문서가 날아가지 않아요";
            F<TextBlock>("Feat3").Text = "공공누리 무료 글꼴 175종 포함";
            F<TextBlock>("BtnMainText").Text = "설치하기";
            F<TextBlock>("Opt1Text").Text = "바탕화면에 바로가기 만들기";
            string prev = Work.InstalledVersion();
            var olds = Work.FindOldInstalls();
            if (prev == null && olds.Count > 0) prev = olds[0].Version;
            F<TextBlock>("Note").Text = prev != null ? "설치된 " + prev + " → " + BuildInfo.Version + "으로 바꿉니다 · 문서와 설정은 그대로" : "";
            F<TextBlock>("Note").Visibility = prev != null ? Visibility.Visible : Visibility.Collapsed;
            UpdateDir();
            F<Border>("DirRow").MouseLeftButtonUp += (s, e) => PickDir();
#else
            F<TextBlock>("Head").Text = "한글 편집기를 지울까요?";
            F<TextBlock>("Sub").Text = "프로그램과 바로가기를 지웁니다.\n만든 문서 파일은 지워지지 않습니다.";
            F<FrameworkElement>("Feats").Visibility = Visibility.Collapsed;
            F<TextBlock>("BtnMainText").Text = "지우기";
            F<Border>("BtnMain").Background = (Brush)new BrushConverter().ConvertFrom("#D64545");
            F<TextBlock>("Opt1Text").Text = "설정과 자동 복구 자료도 함께 지우기";
            desktop = purge;
            F<FrameworkElement>("DirRow").Visibility = Visibility.Collapsed;
            F<TextBlock>("Note").Visibility = Visibility.Collapsed;
#endif
            UpdateCheck();
            F<Border>("Opt1").MouseLeftButtonUp += (s, e) =>
            {
#if SETUP
                desktop = !desktop;
#else
                purge = !purge; desktop = purge;
#endif
                UpdateCheck();
            };
            F<Border>("BtnMain").MouseLeftButtonUp += (s, e) => Start();
            F<Border>("BtnDone").MouseLeftButtonUp += (s, e) => Finish(true);
            F<TextBlock>("LinkClose").MouseLeftButtonUp += (s, e) => Finish(false);
            F<Border>("BtnRetry").MouseLeftButtonUp += (s, e) => Show("PgStart");
            F<TextBlock>("LinkClose2").MouseLeftButtonUp += (s, e) => Window.Close();
#if UNINSTALL
            F<TextBlock>("BtnDoneText").Text = "닫기";
            F<TextBlock>("LinkClose").Visibility = Visibility.Collapsed;
#endif
            Show("PgStart");
        }

        void UpdateCheck()
        {
            F<Border>("Check").Background = desktop ? (Brush)new BrushConverter().ConvertFrom(Blue) : Brushes.White;
            F<FrameworkElement>("CheckMark").Visibility = desktop ? Visibility.Visible : Visibility.Collapsed;
        }

        void UpdateDir() { F<TextBlock>("DirText").Text = dir; }

        void PickDir()
        {
            // 폴더 고르기: Windows 기본 폴더 대화 상자
            var d = new System.Windows.Forms.FolderBrowserDialog { Description = "한글 편집기를 설치할 폴더를 고르세요", SelectedPath = Directory.Exists(dir) ? dir : Path.GetDirectoryName(dir) };
            if (d.ShowDialog() == System.Windows.Forms.DialogResult.OK)
            {
                string p = d.SelectedPath;
                if (!p.TrimEnd('\\').EndsWith("hangul-editor", StringComparison.OrdinalIgnoreCase)) p = Path.Combine(p, "hangul-editor");
                if (!CanWrite(p)) { MessageBox.Show(Window, "이 폴더에는 쓸 수 없습니다(관리자 권한 필요). 다른 폴더를 골라 주세요.", Info.AppName); return; }
                dir = p; UpdateDir();
            }
        }

        static bool CanWrite(string p)
        {
            try
            {
                string probe = p;
                while (!Directory.Exists(probe)) probe = Path.GetDirectoryName(probe);
                string f = Path.Combine(probe, ".write-test-" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(f, ""); File.Delete(f); return true;
            }
            catch { return false; }
        }

        string[] tips = {
            "팁 · 갑자기 꺼져도 자동 복구가 문서를 되살려 줘요.",
            "팁 · 워드 문서를 한글(HWP)로 바로 저장할 수 있어요.",
            "팁 · 공공누리 표시 글꼴은 출처만 밝히면 무료예요.",
            "팁 · 한컴오피스 없이도 HWP를 열고 고칠 수 있어요.",
        };

        void Start()
        {
            if (busy) return;
            busy = true;
            Show("PgWork");
#if SETUP
            F<TextBlock>("WorkHead").Text = "설치하고 있어요";
#else
            F<TextBlock>("WorkHead").Text = "지우고 있어요";
#endif
            int tip = 0;
            F<TextBlock>("Tip").Text = tips[0];
            var tipTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
            tipTimer.Tick += (s, e) => { tip = (tip + 1) % tips.Length; F<TextBlock>("Tip").Text = tips[tip]; };
#if SETUP
            tipTimer.Start();
#else
            F<TextBlock>("Tip").Text = "";
#endif
            var o = new Options(new string[0]) { Dir = dir, NoDesktop = !desktop, Purge = purge, Target = opt.Target, Test = opt.Test };
            double shown = 0;
            var work = new Work(o, (p, s) => Window.Dispatcher.BeginInvoke(new Action(() =>
            {
                if (p < shown) return;
                shown = p;
                F<TextBlock>("Step").Text = s;
                F<TextBlock>("Pct").Text = ((int)Math.Round(p * 100)) + "%";
                double full = F<Border>("Track").ActualWidth;
                F<Border>("Fill").Width = Math.Max(10, full * p);
            })));
            Task.Run(() =>
            {
                try { work.Run(); return (Exception)null; }
                catch (Exception ex) { return ex; }
            }).ContinueWith(t => Window.Dispatcher.BeginInvoke(new Action(() =>
            {
                tipTimer.Stop();
                busy = false;
                if (t.Result == null)
                {
#if SETUP
                    F<TextBlock>("DoneHead").Text = "설치가 끝났습니다";
                    F<TextBlock>("DoneSub").Text = "시작 메뉴" + (desktop ? "와 바탕화면" : "") + "에 '한글 편집기'를 만들었습니다.";
#else
                    F<TextBlock>("DoneHead").Text = "지웠습니다";
                    F<TextBlock>("DoneSub").Text = "한글 편집기를 써 주셔서 고맙습니다.";
#endif
                    Show("PgDone");
                    var sc = new ScaleTransform(0.6, 0.6, 32, 32);
                    F<FrameworkElement>("DoneIcon").RenderTransform = sc;
                    var an = new DoubleAnimation(0.6, 1, TimeSpan.FromMilliseconds(420)) { EasingFunction = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.5 } };
                    sc.BeginAnimation(ScaleTransform.ScaleXProperty, an); sc.BeginAnimation(ScaleTransform.ScaleYProperty, an);
                }
                else
                {
                    var ex = t.Result;
                    F<TextBlock>("ErrText").Text = ex is UserMessage ? ex.Message : "알 수 없는 문제가 생겼습니다.\n" + ex.Message;
                    Show("PgError");
                }
            })));
        }

        void Finish(bool launch)
        {
#if SETUP
            if (launch && !opt.NoLaunch)
            {
                try { Process.Start(new ProcessStartInfo(Path.Combine(dir, Info.ExeName)) { UseShellExecute = true, WorkingDirectory = dir }); } catch { }
            }
#endif
            Window.Close();
        }

        static string Xaml()
        {
            return @"
<Border xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'
        Margin='18' CornerRadius='16' Background='#FFFFFF'>
  <Border.Effect><DropShadowEffect BlurRadius='22' ShadowDepth='4' Opacity='0.22' Color='#1B2A4A'/></Border.Effect>
  <Grid>
    <Grid.ColumnDefinitions><ColumnDefinition Width='272'/><ColumnDefinition Width='*'/></Grid.ColumnDefinitions>

    <!-- 왼쪽: 파란 판 + 겹친 문서 카드 -->
    <Border CornerRadius='16,0,0,16' ClipToBounds='True'>
      <Border.Background>
        <LinearGradientBrush StartPoint='0,0' EndPoint='1,1'>
          <GradientStop Color='#2A63CC' Offset='0'/><GradientStop Color='#3D7FEA' Offset='0.55'/><GradientStop Color='#5C9BF5' Offset='1'/>
        </LinearGradientBrush>
      </Border.Background>
      <Grid>
        <Ellipse Width='260' Height='260' Fill='#FFFFFF' Opacity='0.07' Margin='-90,-110,0,0' HorizontalAlignment='Left' VerticalAlignment='Top'/>
        <Ellipse Width='200' Height='200' Fill='#FFFFFF' Opacity='0.06' Margin='0,0,-70,-60' HorizontalAlignment='Right' VerticalAlignment='Bottom'/>
        <StackPanel Margin='30,34,24,0' VerticalAlignment='Top'>
          <Border Width='60' Height='60' CornerRadius='14' Background='#FFFFFF' HorizontalAlignment='Left'>
            <Border.Effect><DropShadowEffect BlurRadius='12' ShadowDepth='2' Opacity='0.25' Color='#0B2A66'/></Border.Effect>
            <Image x:Name='Logo' Width='46' Height='46' RenderOptions.BitmapScalingMode='HighQuality'/>
          </Border>
          <TextBlock Text='한글 편집기' Foreground='White' FontSize='24' FontWeight='Bold' Margin='0,18,0,0'/>
          <TextBlock x:Name='Ver' Foreground='#DCE8FF' FontSize='12.5' Margin='1,4,0,0'/>
        </StackPanel>
        <!-- 문서 카드 세 장 -->
        <Canvas Width='200' Height='170' HorizontalAlignment='Center' VerticalAlignment='Bottom' Margin='0,0,0,38'>
          <Border Canvas.Left='-6' Canvas.Top='34' Width='112' Height='136' CornerRadius='10' Background='#FFFFFF' Opacity='0.55' RenderTransformOrigin='0.5,0.5'>
            <Border.RenderTransform><RotateTransform Angle='-12'/></Border.RenderTransform>
            <TextBlock Text='DOCX' Margin='10,10,0,0' FontSize='12' FontWeight='Bold' Foreground='#2A63CC'/>
          </Border>
          <Border Canvas.Left='100' Canvas.Top='16' Width='112' Height='136' CornerRadius='10' Background='#FFFFFF' Opacity='0.75' RenderTransformOrigin='0.5,0.5'>
            <Border.RenderTransform><RotateTransform Angle='10'/></Border.RenderTransform>
            <TextBlock Text='HWPX' Margin='0,10,12,0' HorizontalAlignment='Right' FontSize='12' FontWeight='Bold' Foreground='#2A63CC'/>
          </Border>
          <Border Canvas.Left='44' Canvas.Top='26' Width='116' Height='142' CornerRadius='10' Background='#FFFFFF'>
            <Border.Effect><DropShadowEffect BlurRadius='14' ShadowDepth='3' Opacity='0.25' Color='#0B2A66'/></Border.Effect>
            <StackPanel Margin='13,11,13,0'>
              <TextBlock Text='HWP' FontSize='12' FontWeight='Bold' Foreground='#2A63CC'/>
              <Border Height='6' CornerRadius='3' Background='#DCE6F7' Margin='0,12,0,0'/>
              <Border Height='6' CornerRadius='3' Background='#DCE6F7' Margin='0,7,14,0'/>
              <Border Height='6' CornerRadius='3' Background='#DCE6F7' Margin='0,7,0,0'/>
              <Border Height='6' CornerRadius='3' Background='#DCE6F7' Margin='0,7,24,0'/>
              <TextBlock Text='가' FontSize='26' FontWeight='Bold' Foreground='#2F6FD6' HorizontalAlignment='Right' Margin='0,10,0,0'/>
            </StackPanel>
          </Border>
        </Canvas>
      </Grid>
    </Border>

    <!-- 오른쪽 -->
    <Grid Grid.Column='1' Margin='36,20,30,26'>
      <StackPanel Orientation='Horizontal' HorizontalAlignment='Right' VerticalAlignment='Top' Margin='0,-6,-14,0' Panel.ZIndex='5'>
        <Button x:Name='BtnMin' Content='—' Width='34' Height='28' Background='Transparent' BorderThickness='0' Foreground='#8A93A3' FontSize='12' Cursor='Hand'/>
        <Button x:Name='BtnClose' Content='✕' Width='34' Height='28' Background='Transparent' BorderThickness='0' Foreground='#8A93A3' FontSize='13' Cursor='Hand'/>
      </StackPanel>

      <!-- 시작 -->
      <Grid x:Name='PgStart' Margin='0,26,0,0'>
        <StackPanel VerticalAlignment='Top'>
          <TextBlock x:Name='Head' FontSize='23' FontWeight='Bold' Foreground='#1D2430'/>
          <TextBlock x:Name='Sub' FontSize='13.5' Foreground='#5B6575' TextWrapping='Wrap' Margin='0,10,0,0' LineHeight='21'/>
          <StackPanel x:Name='Feats' Margin='0,22,0,0'>
            <StackPanel Orientation='Horizontal' Margin='0,0,0,10'><Border Width='22' Height='22' CornerRadius='11' Background='#E8F0FC'><TextBlock Text='✓' Foreground='#2F6FD6' FontWeight='Bold' HorizontalAlignment='Center' VerticalAlignment='Center' FontSize='12'/></Border><TextBlock x:Name='Feat1' Margin='10,0,0,0' VerticalAlignment='Center' FontSize='13.5' Foreground='#2B3340'/></StackPanel>
            <StackPanel Orientation='Horizontal' Margin='0,0,0,10'><Border Width='22' Height='22' CornerRadius='11' Background='#E8F0FC'><TextBlock Text='✓' Foreground='#2F6FD6' FontWeight='Bold' HorizontalAlignment='Center' VerticalAlignment='Center' FontSize='12'/></Border><TextBlock x:Name='Feat2' Margin='10,0,0,0' VerticalAlignment='Center' FontSize='13.5' Foreground='#2B3340'/></StackPanel>
            <StackPanel Orientation='Horizontal'><Border Width='22' Height='22' CornerRadius='11' Background='#E8F0FC'><TextBlock Text='✓' Foreground='#2F6FD6' FontWeight='Bold' HorizontalAlignment='Center' VerticalAlignment='Center' FontSize='12'/></Border><TextBlock x:Name='Feat3' Margin='10,0,0,0' VerticalAlignment='Center' FontSize='13.5' Foreground='#2B3340'/></StackPanel>
          </StackPanel>
          <TextBlock x:Name='Note' FontSize='12.5' Foreground='#B7740A' TextWrapping='Wrap' Margin='0,16,0,0'/>
        </StackPanel>
        <StackPanel VerticalAlignment='Bottom'>
          <Border x:Name='BtnMain' Height='50' CornerRadius='12' Background='#2F6FD6' Cursor='Hand'>
            <Border.Effect><DropShadowEffect BlurRadius='14' ShadowDepth='3' Opacity='0.28' Color='#2F6FD6'/></Border.Effect>
            <TextBlock x:Name='BtnMainText' Foreground='White' FontSize='16' FontWeight='Bold' HorizontalAlignment='Center' VerticalAlignment='Center'/>
          </Border>
          <Grid Margin='0,14,0,0'>
            <Border x:Name='Opt1' Background='Transparent' Cursor='Hand' HorizontalAlignment='Left'>
              <StackPanel Orientation='Horizontal'>
                <Border x:Name='Check' Width='18' Height='18' CornerRadius='5' BorderBrush='#2F6FD6' BorderThickness='1.5'>
                  <Path x:Name='CheckMark' Data='M3.5,9 L7.5,13 L14.5,5' Stroke='White' StrokeThickness='2.2' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round' Margin='-1,-1,0,0'/>
                </Border>
                <TextBlock x:Name='Opt1Text' Margin='8,0,0,0' FontSize='12.5' Foreground='#3A4352' VerticalAlignment='Center'/>
              </StackPanel>
            </Border>
          </Grid>
          <Border x:Name='DirRow' Background='#F3F5F8' CornerRadius='8' Padding='10,7' Margin='0,10,0,0' Cursor='Hand' ToolTip='눌러서 설치 폴더 바꾸기'>
            <DockPanel>
              <TextBlock Text='바꾸기' DockPanel.Dock='Right' Foreground='#2F6FD6' FontSize='12' FontWeight='Bold' Margin='10,0,0,0' VerticalAlignment='Center'/>
              <TextBlock Text='설치 위치' Foreground='#8A93A3' FontSize='12' Margin='0,0,8,0' VerticalAlignment='Center'/>
              <TextBlock x:Name='DirText' Foreground='#3A4352' FontSize='12' TextTrimming='CharacterEllipsis' VerticalAlignment='Center'/>
            </DockPanel>
          </Border>
        </StackPanel>
      </Grid>

      <!-- 진행 -->
      <Grid x:Name='PgWork' Margin='0,26,0,0' Visibility='Collapsed'>
        <StackPanel VerticalAlignment='Top'>
          <TextBlock x:Name='WorkHead' FontSize='23' FontWeight='Bold' Foreground='#1D2430'/>
          <TextBlock x:Name='Step' FontSize='13.5' Foreground='#5B6575' Margin='0,10,0,0' Text='준비하고 있어요'/>
        </StackPanel>
        <StackPanel VerticalAlignment='Center' Margin='0,20,0,0'>
          <TextBlock x:Name='Pct' Text='0%' FontSize='44' FontWeight='Bold' Foreground='#2F6FD6'/>
          <Border x:Name='Track' Height='12' CornerRadius='6' Background='#E8EDF5' Margin='0,10,0,0'>
            <Border x:Name='Fill' Width='10' HorizontalAlignment='Left' CornerRadius='6'>
              <Border.Background><LinearGradientBrush StartPoint='0,0' EndPoint='1,0'><GradientStop Color='#2A63CC' Offset='0'/><GradientStop Color='#5C9BF5' Offset='1'/></LinearGradientBrush></Border.Background>
            </Border>
          </Border>
        </StackPanel>
        <Border VerticalAlignment='Bottom' Background='#F3F5F8' CornerRadius='10' Padding='14,11'>
          <TextBlock x:Name='Tip' FontSize='12.5' Foreground='#4A5363' TextWrapping='Wrap'/>
        </Border>
      </Grid>

      <!-- 끝 -->
      <Grid x:Name='PgDone' Margin='0,26,0,0' Visibility='Collapsed'>
        <StackPanel VerticalAlignment='Top'>
          <Grid x:Name='DoneIcon' Width='64' Height='64' HorizontalAlignment='Left'>
            <Ellipse Fill='#E6F4EC'/>
            <Path Data='M19,33 L28,42 L46,23' Stroke='#1F8A4C' StrokeThickness='5' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
          </Grid>
          <TextBlock x:Name='DoneHead' FontSize='23' FontWeight='Bold' Foreground='#1D2430' Margin='0,20,0,0'/>
          <TextBlock x:Name='DoneSub' FontSize='13.5' Foreground='#5B6575' TextWrapping='Wrap' Margin='0,10,0,0'/>
        </StackPanel>
        <StackPanel VerticalAlignment='Bottom'>
          <Border x:Name='BtnDone' Height='50' CornerRadius='12' Background='#2F6FD6' Cursor='Hand'>
            <Border.Effect><DropShadowEffect BlurRadius='14' ShadowDepth='3' Opacity='0.28' Color='#2F6FD6'/></Border.Effect>
            <TextBlock x:Name='BtnDoneText' Text='시작하기' Foreground='White' FontSize='16' FontWeight='Bold' HorizontalAlignment='Center' VerticalAlignment='Center'/>
          </Border>
          <TextBlock x:Name='LinkClose' Text='나중에 시작하기' Foreground='#8A93A3' FontSize='12.5' HorizontalAlignment='Center' Margin='0,14,0,0' Cursor='Hand'/>
        </StackPanel>
      </Grid>

      <!-- 오류 -->
      <Grid x:Name='PgError' Margin='0,26,0,0' Visibility='Collapsed'>
        <StackPanel VerticalAlignment='Top'>
          <Grid Width='64' Height='64' HorizontalAlignment='Left'>
            <Ellipse Fill='#FDECEC'/>
            <TextBlock Text='!' FontSize='34' FontWeight='Bold' Foreground='#D64545' HorizontalAlignment='Center' VerticalAlignment='Center'/>
          </Grid>
          <TextBlock Text='끝내지 못했습니다' FontSize='23' FontWeight='Bold' Foreground='#1D2430' Margin='0,20,0,0'/>
          <TextBlock x:Name='ErrText' FontSize='13.5' Foreground='#5B6575' TextWrapping='Wrap' Margin='0,10,0,0'/>
        </StackPanel>
        <StackPanel VerticalAlignment='Bottom'>
          <Border x:Name='BtnRetry' Height='50' CornerRadius='12' Background='#2F6FD6' Cursor='Hand'>
            <TextBlock Text='다시 시도' Foreground='White' FontSize='16' FontWeight='Bold' HorizontalAlignment='Center' VerticalAlignment='Center'/>
          </Border>
          <TextBlock x:Name='LinkClose2' Text='닫기' Foreground='#8A93A3' FontSize='12.5' HorizontalAlignment='Center' Margin='0,14,0,0' Cursor='Hand'/>
        </StackPanel>
      </Grid>
    </Grid>
  </Grid>
</Border>";
        }
    }
}
