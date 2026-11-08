; Inno Setup script for Aether-Setup.exe. Built by desktop\build.ps1 (needs Inno Setup 6).
; Installs per user (no admin prompt) into %LOCALAPPDATA%\Programs\Aether.
; Your library lives in %USERPROFILE%\.aether and is never touched by install, update or uninstall.

#define AppVersion GetEnv("AETHER_VERSION")
#if AppVersion == ""
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6E2D8C1A-4B7F-4C9E-9A3D-AE7E0000AE01}
AppName=Aether
AppVersion={#AppVersion}
AppVerName=Aether {#AppVersion}
AppPublisher=Noco
DefaultDirName={localappdata}\Programs\Aether
DefaultGroupName=Aether
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Aether-Setup-{#AppVersion}
SetupIconFile=aether.ico
UninstallDisplayIcon={app}\Aether.exe
UninstallDisplayName=Aether
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\Aether\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; an update replaces the program folder completely, so no stale files survive
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\Aether"; Filename: "{app}\Aether.exe"
Name: "{autodesktop}\Aether"; Filename: "{app}\Aether.exe"; Tasks: desktopicon

[Registry]
; the app writes its own start-at-login entry (Settings in the app); uninstall removes it
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "Aether"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\Aether.exe"; Description: "Open Aether"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM Aether.exe"; Flags: runhidden; RunOnceId: "StopAether"

[Code]
// Stop a running Aether (window and background engine) before files are replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Aether.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(800);
  Result := '';
end;
