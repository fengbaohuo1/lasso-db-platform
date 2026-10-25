; 卸载后清理快捷方式（Tauri NSIS 在静默卸载/自定义 /D 安装时可能残留）
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\DB Platform.lnk"
  Delete "$DESKTOP\DB Platform.lnk"
!macroend
