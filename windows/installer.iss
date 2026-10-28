; Dvarim for Windows: an installer for one person, which needs no administrator.
; It copies what dotnet publish made (build\Dvarim) to %LOCALAPPDATA%\Programs\Dvarim,
; puts Dvarim in the Start menu and, unless the box is unticked, starts it when you
; sign in to Windows, put away in the notification area, so reminders arrive and
; Quick Entry answers. Made by windows\build.ps1 and the Windows workflow:
;
;   iscc /DVersion=0.1.0 windows\installer.iss
;
; Uninstalling leaves your to-dos alone, the copy and the settings in %LOCALAPPDATA%\Dvarim
; too, and the token in Credential Manager (sign out in Dvarim first to take it off the server).

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Source
  #define Source "..\build\Dvarim"
#endif

[Setup]
AppId={{3C9E5B71-2F4A-4D8E-A6B0-7E1D9C2F5A48}
AppName=Dvarim
AppVersion={#Version}
AppVerName=Dvarim {#Version}
AppPublisher=franz-rosenzweig
AppPublisherURL=https://github.com/franz-rosenzweig/dvarim
AppSupportURL=https://github.com/franz-rosenzweig/dvarim/blob/master/docs/windows.md
DefaultDirName={localappdata}\Programs\Dvarim
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\build\out
OutputBaseFilename=Dvarim-{#Version}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#Source}\Assets\Dvarim.ico
UninstallDisplayIcon={app}\Dvarim.exe
UninstallDisplayName=Dvarim
; Dvarim keeps running in the notification area: Windows' Restart Manager asks it to quit first
CloseApplications=yes

[Tasks]
; offered on the first install only: an update leaves it as Dvarim's Settings last left it
Name: startup; Description: "Start Dvarim when I sign in to Windows (for reminders and Quick Entry)"; Check: FirstInstall
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; an update leaves none of the old web app's files behind
Type: filesandordirs; Name: "{app}\web"

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Dvarim"; Filename: "{app}\Dvarim.exe"
Name: "{autodesktop}\Dvarim"; Filename: "{app}\Dvarim.exe"; Tasks: desktopicon

[Registry]
; the same value Dvarim's Settings turns on and off (Startup in Support.cs)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Dvarim"; ValueData: """{app}\Dvarim.exe"" --background"; Tasks: startup; Flags: uninsdeletevalue

[UninstallRun]
; quit the copy in the notification area, so its files can go
Filename: "{sys}\taskkill.exe"; Parameters: "/IM Dvarim.exe /F"; Flags: runhidden; RunOnceId: "QuitDvarim"

[Run]
Filename: "{app}\Dvarim.exe"; Description: "{cm:LaunchProgram,Dvarim}"; Flags: nowait postinstall skipifsilent

[Code]
function FirstInstall: Boolean;
begin
  Result := not RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{3C9E5B71-2F4A-4D8E-A6B0-7E1D9C2F5A48}_is1');
end;
