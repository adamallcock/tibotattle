; This is an electron-builder NSIS include, not a replacement installer.nsi.
; Keep the association closed to the one semantic desktop target owned by the
; Electron runtime: usagemonitor://open. The runtime validates %1 again.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\usagemonitor" "" "URL:com.usagemonitor.local.open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\usagemonitor" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\usagemonitor\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\usagemonitor"
!macroend
