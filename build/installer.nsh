; After the files are installed: offer to run Pioneer's DDJ-SB driver installer (Windows needs it for the controller's MIDI port).
!macro customInstall
  ${IfNot} ${Silent}
    IfFileExists "$INSTDIR\resources\drivers\Pioneer_DDJ_SB_Driver_1.100.exe" 0 +4
      MessageBox MB_YESNO|MB_ICONQUESTION "Install the Pioneer DDJ-SB driver now?$\r$\n$\r$\nWindows needs Pioneer's driver to give the DDJ-SB controller its MIDI port. Skip this if it is already installed (Pioneer's installer will tell you)." IDNO +2
      ExecWait '"$INSTDIR\resources\drivers\Pioneer_DDJ_SB_Driver_1.100.exe"'
  ${EndIf}
!macroend
