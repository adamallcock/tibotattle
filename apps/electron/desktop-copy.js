/**
 * Main-process copy for the Electron menu, tray, picker, and status surfaces.
 *
 * The renderer owns the larger dashboard catalog. This small Electron-owned
 * catalog keeps the main process out of the web app boundary while preserving
 * the same locale IDs and fail-safe language negotiation: system, English,
 * Simplified Chinese, and Spanish.
 */

const DEFAULT_LOCALE = "en-US";
const SUPPORTED_LOCALES = Object.freeze([DEFAULT_LOCALE, "zh-Hans", "es"]);

const DESKTOP_MESSAGES = Object.freeze({
  "electron.firstRun.title": Object.freeze({
    "en-US": "TiboTattle local data",
    "zh-Hans": "TiboTattle 本地数据",
    es: "Datos locales de TiboTattle",
  }),
  "electron.firstRun.message": Object.freeze({
    "en-US": "TiboTattle updates local Codex metadata while the app is open. The first pass starts after setup; later checks reuse the same bounded local companion.",
    "zh-Hans": "TiboTattle 会在应用打开时更新本地 Codex 元数据。首次分析会在设置完成后开始，之后的检查会复用同一个有界本地配套服务。",
    es: "TiboTattle actualiza los metadatos locales de Codex mientras la aplicación está abierta. El primer análisis comienza después de la configuración; las comprobaciones posteriores reutilizan el mismo servicio auxiliar local acotado.",
  }),
  "electron.firstRun.detail": Object.freeze({
    "en-US": "Reads: timestamps, model and speed labels, token counters, tool categories, and quota snapshots from the selected Codex sessions folders.\n\nStores: content-free indexes, cached calculations, settings, and any prepared contribution in your owner-only TiboTattle app-data folder.\n\nLocal analysis runs on this computer. Fresh installations enable community sharing without sign-in. Existing installations without a saved choice receive three notices before automatic activation. You can turn sharing off persistently in Settings; an explicit earlier opt-out stays off. Uploads are not available in this build.\n\nLocal allowance notifications are off by default. Supported packaged builds can deliver a local alert after fresh provider-reported evidence crosses a selected threshold. This development build cannot deliver OS alerts until it has a supported app identity; TiboTattle does not add background polling.\n\nUpdates: this development build does not include update checks. Signed production releases can check for updates from About.\n\nNever contributed: prompts, responses, file paths, repositories, commands, credentials, emails, or account names.\n\nKeep the app open while analysis runs. You may close and reopen the TiboTattle window; quitting the app stops the current pass and preserves completed checkpoints.\n\nBy default, first-run setup preselects Start TiboTattle at login. TiboTattle adds an operating-system login item only after you click Continue; it uses no LaunchAgent, daemon, privileged helper, or hidden persistent process.\n\nContinue to start the local dashboard, or Quit to leave the app closed.",
    "zh-Hans": "读取：从选定的 Codex 会话文件夹读取时间戳、模型和速度标签、令牌计数、工具类别以及配额快照。\n\n存储：在仅限你本人访问的 TiboTattle 应用数据文件夹中存储不含内容的索引、缓存计算结果、设置以及任何准备好的贡献数据。\n\n本地分析在此电脑上运行。新安装默认开启社区共享，无需登录。没有保存选择的现有安装会在自动开启前收到三次提示。你可以在“设置”中持久关闭共享；以前明确关闭的选择会保留。此版本暂不支持上传。\n\n本地配额提醒默认关闭。支持的已打包版本可以在最新的提供商报告证据越过所选阈值后发送本地提醒。此开发版本在获得受支持的应用身份前无法发送系统提醒；TiboTattle 不会添加后台轮询。\n\n更新：此开发版本不包含更新检查。已签名的生产版本可以从“关于”中检查更新。\n\n从未贡献：提示、回复、文件路径、代码仓库、命令、凭据、电子邮件或账户名称。\n\n分析运行期间请保持应用打开。你可以关闭并重新打开 TiboTattle 窗口；退出应用会停止当前分析，并保留已完成的检查点。\n\n首次设置默认预选“登录时启动 TiboTattle”。只有在你点击“继续”后，TiboTattle 才会添加操作系统登录项；它不会使用 LaunchAgent、守护进程、特权帮助程序或隐藏的常驻进程。\n\n选择“继续”以启动本地仪表板，或选择“退出”以保持应用关闭。",
    es: "Lee: marcas de tiempo, etiquetas de modelo y velocidad, contadores de tokens, categorías de herramientas y capturas de cuotas de las carpetas de sesiones de Codex seleccionadas.\n\nGuarda: índices sin contenido, cálculos en caché, configuración y cualquier contribución preparada en la carpeta de datos de la aplicación TiboTattle, protegida para tu usuario.\n\nEl análisis local se ejecuta en este equipo. Las instalaciones nuevas activan la compartición comunitaria sin iniciar sesión. Las instalaciones existentes sin una elección guardada reciben tres avisos antes de la activación automática. Puedes desactivar la compartición de forma persistente en Configuración; una desactivación explícita anterior se conserva. Las cargas no están disponibles en esta compilación.\n\nLas notificaciones locales de cuota están desactivadas de forma predeterminada. Las versiones empaquetadas compatibles pueden enviar una alerta local después de que evidencia reciente informada por el proveedor supere el umbral seleccionado. Esta compilación de desarrollo no puede enviar alertas del sistema hasta tener una identidad de aplicación compatible; TiboTattle no añade sondeo en segundo plano.\n\nActualizaciones: esta compilación de desarrollo no incluye comprobaciones de actualización. Las versiones de producción firmadas pueden comprobar actualizaciones desde Acerca de.\n\nNunca se contribuye: indicaciones, respuestas, rutas de archivos, repositorios, comandos, credenciales, correos electrónicos ni nombres de cuenta.\n\nMantén la aplicación abierta mientras se ejecuta el análisis. Puedes cerrar y volver a abrir la ventana de TiboTattle; salir de la aplicación detiene el análisis actual y conserva los puntos de control completados.\n\nDe forma predeterminada, la configuración inicial preselecciona Iniciar TiboTattle al iniciar sesión. TiboTattle añade un elemento de inicio del sistema operativo solo después de que hagas clic en Continuar; no usa LaunchAgent, demonios, asistentes privilegiados ni procesos persistentes ocultos.\n\nElige Continuar para iniciar el panel local o Salir para dejar la aplicación cerrada.",
  }),
  "electron.firstRun.checkbox.startAtLogin": Object.freeze({
    "en-US": "Start TiboTattle at login (you can change this later in Settings)",
    "zh-Hans": "登录时启动 TiboTattle（稍后可在“设置”中更改）",
    es: "Iniciar TiboTattle al iniciar sesión (puedes cambiarlo después en Configuración)",
  }),
  "electron.firstRun.loginRegistration.title": Object.freeze({
    "en-US": "TiboTattle will continue without Start at login",
    "zh-Hans": "TiboTattle 将继续启动，但不会在登录时启动",
    es: "TiboTattle continuará sin iniciarse al iniciar sesión",
  }),
  "electron.firstRun.loginRegistration.message": Object.freeze({
    "en-US": "The operating system did not confirm Start at login.",
    "zh-Hans": "操作系统未确认“登录时启动”。",
    es: "El sistema operativo no confirmó el inicio de sesión automático.",
  }),
  "electron.firstRun.loginRegistration.detail": Object.freeze({
    "en-US": "TiboTattle will continue starting now. You can review or approve this setting in Login Items.",
    "zh-Hans": "TiboTattle 现在仍会继续启动。你可以在“登录项”中查看或批准此设置。",
    es: "TiboTattle continuará iniciándose ahora. Puedes revisar o aprobar esta configuración en Elementos de inicio.",
  }),
  "electron.firstRun.loginRegistration.continue": Object.freeze({
    "en-US": "Continue",
    "zh-Hans": "继续",
    es: "Continuar",
  }),
  "electron.firstRun.loginRegistration.openSettings": Object.freeze({
    "en-US": "Open Login Items Settings",
    "zh-Hans": "打开登录项设置",
    es: "Abrir configuración de elementos de inicio",
  }),
  "electron.firstRun.failure.title": Object.freeze({
    "en-US": "TiboTattle cannot start safely",
    "zh-Hans": "TiboTattle 无法安全启动",
    es: "TiboTattle no puede iniciarse de forma segura",
  }),
  "electron.firstRun.failure.message": Object.freeze({
    "en-US": "TiboTattle could not verify its local privacy acknowledgement, so it did not start the companion.",
    "zh-Hans": "TiboTattle 无法验证本地隐私确认，因此没有启动配套服务。",
    es: "TiboTattle no pudo verificar su confirmación de privacidad local, por lo que no inició el servicio auxiliar.",
  }),
  "electron.firstRun.failure.detail": Object.freeze({
    "en-US": "Review the application data directory and try again. No local companion or login item was started.",
    "zh-Hans": "请检查应用数据目录后重试。未启动本地配套服务或登录项。",
    es: "Revisa el directorio de datos de la aplicación e inténtalo de nuevo. No se inició el servicio auxiliar local ni el elemento de inicio.",
  }),
  "electron.firstRun.continue": Object.freeze({
    "en-US": "Continue",
    "zh-Hans": "继续",
    es: "Continuar",
  }),
  "electron.firstRun.quit": Object.freeze({
    "en-US": "Quit",
    "zh-Hans": "退出",
    es: "Salir",
  }),
  "electron.notification.threshold80.title": Object.freeze({
    "en-US": "Quota usage reached 80%",
    "zh-Hans": "配额使用量已达到 80%",
    es: "El uso de la cuota alcanzó el 80 %",
  }),
  "electron.notification.threshold80.body": Object.freeze({
    "en-US": "A fresh provider-reported observation crossed the 80% usage threshold.",
    "zh-Hans": "最新的提供商报告观测已越过 80% 使用量阈值。",
    es: "Una observación reciente informada por el proveedor superó el umbral de uso del 80 %.",
  }),
  "electron.notification.threshold90.title": Object.freeze({
    "en-US": "Quota usage reached 90%",
    "zh-Hans": "配额使用量已达到 90%",
    es: "El uso de la cuota alcanzó el 90 %",
  }),
  "electron.notification.threshold90.body": Object.freeze({
    "en-US": "A fresh provider-reported observation crossed the 90% usage threshold.",
    "zh-Hans": "最新的提供商报告观测已越过 90% 使用量阈值。",
    es: "Una observación reciente informada por el proveedor superó el umbral de uso del 90 %.",
  }),
  "electron.notification.reset.title": Object.freeze({
    "en-US": "Quota reset observed",
    "zh-Hans": "检测到配额重置",
    es: "Se observó un reinicio de la cuota",
  }),
  "electron.notification.reset.body": Object.freeze({
    "en-US": "Fresh provider-reported quota evidence shows that the window has reset.",
    "zh-Hans": "最新的提供商报告配额证据显示，该时间窗口已重置。",
    es: "La evidencia reciente de cuota informada por el proveedor muestra que la ventana se reinició.",
  }),
  "electron.recovery.windowTitle": Object.freeze({
    "en-US": "TiboTattle",
    "zh-Hans": "TiboTattle",
    es: "TiboTattle",
  }),
  "electron.recovery.starting.title": Object.freeze({
    "en-US": "Starting TiboTattle",
    "zh-Hans": "正在启动 TiboTattle",
    es: "Iniciando TiboTattle",
  }),
  "electron.recovery.starting.detail": Object.freeze({
    "en-US": "Starting the local usage service…",
    "zh-Hans": "正在启动本地使用服务…",
    es: "Iniciando el servicio de uso local…",
  }),
  "electron.recovery.companionSpawnFailed.title": Object.freeze({
    "en-US": "TiboTattle could not start",
    "zh-Hans": "TiboTattle 无法启动",
    es: "No se pudo iniciar TiboTattle",
  }),
  "electron.recovery.companionSpawnFailed.detail": Object.freeze({
    "en-US": "The local usage service could not be started.",
    "zh-Hans": "无法启动本地使用服务。",
    es: "No se pudo iniciar el servicio de uso local.",
  }),
  "electron.recovery.companionStartTimeout.title": Object.freeze({
    "en-US": "TiboTattle is taking too long to start",
    "zh-Hans": "TiboTattle 启动时间过长",
    es: "TiboTattle está tardando demasiado en iniciarse",
  }),
  "electron.recovery.companionStartTimeout.detail": Object.freeze({
    "en-US": "The local usage service did not become ready in time.",
    "zh-Hans": "本地使用服务未能及时就绪。",
    es: "El servicio de uso local no estuvo listo a tiempo.",
  }),
  "electron.recovery.companionExitBeforeReady.title": Object.freeze({
    "en-US": "TiboTattle stopped during startup",
    "zh-Hans": "TiboTattle 在启动期间停止",
    es: "TiboTattle se detuvo durante el inicio",
  }),
  "electron.recovery.companionExitBeforeReady.detail": Object.freeze({
    "en-US": "The local usage service stopped before it became ready.",
    "zh-Hans": "本地使用服务在就绪前停止。",
    es: "El servicio de uso local se detuvo antes de estar listo.",
  }),
  "electron.recovery.companionReadyInvalid.title": Object.freeze({
    "en-US": "TiboTattle could not start",
    "zh-Hans": "TiboTattle 无法启动",
    es: "No se pudo iniciar TiboTattle",
  }),
  "electron.recovery.companionReadyInvalid.detail": Object.freeze({
    "en-US": "The local usage service returned an invalid startup signal.",
    "zh-Hans": "本地使用服务返回了无效的启动信号。",
    es: "El servicio de uso local devolvió una señal de inicio no válida.",
  }),
  "electron.recovery.companionReadyOverflow.title": Object.freeze({
    "en-US": "TiboTattle could not start",
    "zh-Hans": "TiboTattle 无法启动",
    es: "No se pudo iniciar TiboTattle",
  }),
  "electron.recovery.companionReadyOverflow.detail": Object.freeze({
    "en-US": "The local usage service returned an oversized startup signal.",
    "zh-Hans": "本地使用服务返回了过大的启动信号。",
    es: "El servicio de uso local devolvió una señal de inicio demasiado grande.",
  }),
  "electron.recovery.companionShutdownTimeout.title": Object.freeze({
    "en-US": "TiboTattle could not restart",
    "zh-Hans": "TiboTattle 无法重新启动",
    es: "TiboTattle no pudo reiniciarse",
  }),
  "electron.recovery.companionShutdownTimeout.detail": Object.freeze({
    "en-US": "The previous local usage service did not stop in time.",
    "zh-Hans": "之前的本地使用服务未能及时停止。",
    es: "El servicio de uso local anterior no se detuvo a tiempo.",
  }),
  "electron.recovery.companionBusy.title": Object.freeze({
    "en-US": "TiboTattle is busy",
    "zh-Hans": "TiboTattle 正忙",
    es: "TiboTattle está ocupado",
  }),
  "electron.recovery.companionBusy.detail": Object.freeze({
    "en-US": "The local usage service is already being restarted.",
    "zh-Hans": "本地使用服务已在重新启动。",
    es: "El servicio de uso local ya se está reiniciando.",
  }),
  "electron.recovery.diagnostic": Object.freeze({
    "en-US": "Diagnostic: {code}",
    "zh-Hans": "诊断：{code}",
    es: "Diagnóstico: {code}",
  }),
  "electron.recovery.retry": Object.freeze({
    "en-US": "Retry",
    "zh-Hans": "重试",
    es: "Reintentar",
  }),
  "electron.recovery.settings": Object.freeze({
    "en-US": "Settings",
    "zh-Hans": "设置",
    es: "Configuración",
  }),
  "electron.recovery.diagnostics": Object.freeze({
    "en-US": "Diagnostics",
    "zh-Hans": "诊断信息",
    es: "Diagnósticos",
  }),
  "electron.recovery.settings.title": Object.freeze({
    "en-US": "Repair Codex folder",
    "zh-Hans": "修复 Codex 文件夹",
    es: "Reparar la carpeta de Codex",
  }),
  "electron.recovery.settings.message": Object.freeze({
    "en-US": "TiboTattle could not start with the configured Codex folder.",
    "zh-Hans": "TiboTattle 无法使用已配置的 Codex 文件夹启动。",
    es: "TiboTattle no pudo iniciarse con la carpeta de Codex configurada.",
  }),
  "electron.recovery.settings.detail": Object.freeze({
    "en-US": "Choose a different Codex folder, use the default folder, or cancel. This recovery dialog does not display folder paths.",
    "zh-Hans": "请选择其他 Codex 文件夹、使用默认文件夹或取消。此恢复对话框不会显示文件夹路径。",
    es: "Elige otra carpeta de Codex, usa la carpeta predeterminada o cancela. Este diálogo de recuperación no muestra rutas de carpetas.",
  }),
  "electron.recovery.settings.choose": Object.freeze({
    "en-US": "Choose Codex Folder",
    "zh-Hans": "选择 Codex 文件夹",
    es: "Elegir carpeta de Codex",
  }),
  "electron.recovery.settings.useDefault": Object.freeze({
    "en-US": "Use Default Folder",
    "zh-Hans": "使用默认文件夹",
    es: "Usar carpeta predeterminada",
  }),
  "electron.recovery.settings.cancel": Object.freeze({
    "en-US": "Cancel",
    "zh-Hans": "取消",
    es: "Cancelar",
  }),
  "electron.recovery.settings.failureTitle": Object.freeze({
    "en-US": "Codex folder could not be changed",
    "zh-Hans": "无法更改 Codex 文件夹",
    es: "No se pudo cambiar la carpeta de Codex",
  }),
  "electron.recovery.settings.failureMessage": Object.freeze({
    "en-US": "TiboTattle could not apply that folder choice.",
    "zh-Hans": "TiboTattle 无法应用该文件夹选择。",
    es: "TiboTattle no pudo aplicar esa elección de carpeta.",
  }),
  "electron.recovery.settings.failureDetail": Object.freeze({
    "en-US": "No folder path or internal error is shown here. Retry startup or quit and try again.",
    "zh-Hans": "此处不会显示文件夹路径或内部错误。请重试启动，或退出后再试。",
    es: "Aquí no se muestran rutas de carpetas ni errores internos. Reintenta el inicio o sal y vuelve a intentarlo.",
  }),
  "electron.recovery.quit": Object.freeze({
    "en-US": "Quit",
    "zh-Hans": "退出",
    es: "Salir",
  }),
  "electron.settings.login.status.enabled": Object.freeze({
    "en-US": "TiboTattle starts when you sign in.",
    "zh-Hans": "登录时 TiboTattle 会启动。",
    es: "TiboTattle se inicia al iniciar sesión.",
  }),
  "electron.settings.login.status.disabled": Object.freeze({
    "en-US": "TiboTattle will not start automatically.",
    "zh-Hans": "TiboTattle 不会自动启动。",
    es: "TiboTattle no se iniciará automáticamente.",
  }),
  "electron.settings.login.status.needsApproval": Object.freeze({
    "en-US": "Your operating system needs approval in Login Items before this can take effect.",
    "zh-Hans": "操作系统需要在登录项中批准后才能生效。",
    es: "El sistema operativo necesita aprobación en los elementos de inicio antes de que esto tenga efecto.",
  }),
  "electron.settings.login.status.unavailable": Object.freeze({
    "en-US": "Login item status is unavailable. Open your operating system Login Items settings to review it.",
    "zh-Hans": "登录项状态不可用。请打开操作系统的登录项设置进行查看。",
    es: "El estado del elemento de inicio no está disponible. Abre la configuración de elementos de inicio del sistema para revisarlo.",
  }),
  "electron.settings.login.status.error": Object.freeze({
    "en-US": "The operating system did not confirm the current Login Item status. Review it before relying on start at login.",
    "zh-Hans": "操作系统未确认当前登录项状态。依赖登录时启动前请先查看。",
    es: "El sistema operativo no confirmó el estado actual del elemento de inicio. Revísalo antes de confiar en el inicio de sesión.",
  }),
  "electron.settings.notifications.permissionStatus": Object.freeze({
    "en-US": "Operating-system permission is shown here; local alert capability is reported above.",
    "zh-Hans": "此处显示操作系统权限；本地提醒功能状态见上方。",
    es: "Aquí se muestra el permiso del sistema operativo; la capacidad de alertas locales aparece arriba.",
  }),
  "electron.settings.notifications.status.ready": Object.freeze({
    "en-US": "Local allowance alerts are ready. Alerts use fresh provider-reported evidence only.",
    "zh-Hans": "本地配额提醒已就绪。提醒只使用最新的提供商报告证据。",
    es: "Las alertas locales de cuota están listas. Solo usan evidencia reciente informada por el proveedor.",
  }),
  "electron.settings.notifications.status.developmentUnavailable": Object.freeze({
    "en-US": "Local alerts are unavailable in this development build. Use a packaged build with a supported app identity.",
    "zh-Hans": "此开发版本无法使用本地提醒。请使用具有受支持应用身份的打包版本。",
    es: "Las alertas locales no están disponibles en esta compilación de desarrollo. Usa una versión empaquetada con una identidad compatible.",
  }),
  "electron.settings.notifications.status.windowsIdentityUnavailable": Object.freeze({
    "en-US": "Local alerts are disabled until this Windows build has a verified app identity.",
    "zh-Hans": "在此 Windows 版本拥有经过验证的应用身份前，本地提醒已禁用。",
    es: "Las alertas locales están desactivadas hasta que esta compilación de Windows tenga una identidad de aplicación verificada.",
  }),
  "electron.settings.notifications.status.unsupported": Object.freeze({
    "en-US": "This operating system does not provide the required local notification capability.",
    "zh-Hans": "此操作系统不提供所需的本地提醒功能。",
    es: "Este sistema operativo no proporciona la capacidad de notificaciones locales requerida.",
  }),
  "electron.settings.notifications.status.capabilityError": Object.freeze({
    "en-US": "The operating system could not confirm local alert delivery. Alerts remain disabled.",
    "zh-Hans": "操作系统无法确认本地提醒发送能力。提醒仍处于禁用状态。",
    es: "El sistema operativo no pudo confirmar el envío de alertas locales. Las alertas permanecen desactivadas.",
  }),
  "electron.settings.notifications.status.unavailable": Object.freeze({
    "en-US": "Local allowance alerts are unavailable. No alerts will be sent.",
    "zh-Hans": "本地配额提醒不可用。不会发送提醒。",
    es: "Las alertas locales de cuota no están disponibles. No se enviarán alertas.",
  }),
  "electron.settings.codexFolder.title": Object.freeze({
    "en-US": "Choose Codex folder",
    "zh-Hans": "选择 Codex 文件夹",
    es: "Elegir carpeta de Codex",
  }),
  "electron.settings.codexFolder.useDefault": Object.freeze({
    "en-US": "Use this folder",
    "zh-Hans": "使用此文件夹",
    es: "Usar esta carpeta",
  }),
  "electron.settings.codexFolder.default": Object.freeze({
    "en-US": "Default location (~/.codex)",
    "zh-Hans": "默认位置 (~/.codex)",
    es: "Ubicación predeterminada (~/.codex)",
  }),
  "electron.settings.updates.unavailable": Object.freeze({
    "en-US": "Update checks are unavailable in this development build.",
    "zh-Hans": "此开发构建中无法检查更新。",
    es: "Las comprobaciones de actualización no están disponibles en esta compilación de desarrollo.",
  }),
  "electron.settings.updates.automaticUnavailable": Object.freeze({
    "en-US": "Automatic updates are unavailable in this development build.",
    "zh-Hans": "此开发构建中无法使用自动更新。",
    es: "Las actualizaciones automáticas no están disponibles en esta compilación de desarrollo.",
  }),
  "electron.diagnostics.title": Object.freeze({
    "en-US": "TiboTattle diagnostics",
    "zh-Hans": "TiboTattle 诊断信息",
    es: "Diagnósticos de TiboTattle",
  }),
  "electron.diagnostics.message": Object.freeze({
    "en-US": "Content-free diagnostics",
    "zh-Hans": "不含内容的诊断信息",
    es: "Diagnósticos sin contenido",
  }),
  "electron.diagnostics.copy": Object.freeze({
    "en-US": "Copy diagnostics",
    "zh-Hans": "复制诊断信息",
    es: "Copiar diagnósticos",
  }),
  "electron.diagnostics.done": Object.freeze({
    "en-US": "Done",
    "zh-Hans": "完成",
    es: "Listo",
  }),
  "electron.menu.about": Object.freeze({
    "en-US": "About {appName}",
    "zh-Hans": "关于 {appName}",
    es: "Acerca de {appName}",
  }),
  "electron.menu.settings": Object.freeze({
    "en-US": "Settings…",
    "zh-Hans": "设置…",
    es: "Configuración…",
  }),
  "electron.menu.quit": Object.freeze({
    "en-US": "Quit {appName}",
    "zh-Hans": "退出 {appName}",
    es: "Salir de {appName}",
  }),
  "electron.menu.file": Object.freeze({
    "en-US": "File",
    "zh-Hans": "文件",
    es: "Archivo",
  }),
  "electron.menu.open": Object.freeze({
    "en-US": "Open",
    "zh-Hans": "打开",
    es: "Abrir",
  }),
  "electron.menu.exit": Object.freeze({
    "en-US": "Exit",
    "zh-Hans": "退出",
    es: "Salir",
  }),
  "electron.menu.edit": Object.freeze({
    "en-US": "Edit",
    "zh-Hans": "编辑",
    es: "Editar",
  }),
  "electron.menu.view": Object.freeze({
    "en-US": "View",
    "zh-Hans": "视图",
    es: "Ver",
  }),
  "electron.menu.refresh": Object.freeze({
    "en-US": "Update Local Usage",
    "zh-Hans": "更新本地使用情况",
    es: "Actualizar uso local",
  }),
  "electron.menu.weekly": Object.freeze({
    "en-US": "Weekly Allowance",
    "zh-Hans": "每周配额",
    es: "Asignación semanal",
  }),
  "electron.menu.timeline": Object.freeze({
    "en-US": "Usage Timeline",
    "zh-Hans": "使用时间线",
    es: "Cronología de uso",
  }),
  "electron.menu.toggleSidebar": Object.freeze({
    "en-US": "Toggle Sidebar",
    "zh-Hans": "切换侧边栏",
    es: "Alternar barra lateral",
  }),
  "electron.menu.show": Object.freeze({
    "en-US": "Show {appName}",
    "zh-Hans": "显示 {appName}",
    es: "Mostrar {appName}",
  }),
  "electron.menu.focus": Object.freeze({
    "en-US": "Focus {appName}",
    "zh-Hans": "聚焦 {appName}",
    es: "Enfocar {appName}",
  }),
  "electron.menu.window": Object.freeze({
    "en-US": "Window",
    "zh-Hans": "窗口",
    es: "Ventana",
  }),
  "electron.menu.help": Object.freeze({
    "en-US": "Help",
    "zh-Hans": "帮助",
    es: "Ayuda",
  }),
  "electron.tray.open": Object.freeze({
    "en-US": "Open {appName}",
    "zh-Hans": "打开 {appName}",
    es: "Abrir {appName}",
  }),
  "electron.tray.weekly": Object.freeze({
    "en-US": "Weekly Allowance",
    "zh-Hans": "每周配额",
    es: "Asignación semanal",
  }),
  "electron.tray.timeline": Object.freeze({
    "en-US": "Usage Timeline",
    "zh-Hans": "使用时间线",
    es: "Cronología de uso",
  }),
  "electron.tray.allowanceTitle": Object.freeze({
    "en-US": "{appName} · {allowance} allowance",
    "zh-Hans": "{appName} · 剩余 {allowance}",
    es: "{appName} · {allowance} disponible",
  }),
  "electron.tray.evidenceCurrent": Object.freeze({
    "en-US": "Observed {age} · verified current evidence",
    "zh-Hans": "{age}前观测 · 当前证据已验证",
    es: "Observado hace {age} · evidencia actual verificada",
  }),
  "electron.tray.windowFiveHour": Object.freeze({
    "en-US": "Five-hour allowance: {remainingPercent}% remaining · resets in {reset}",
    "zh-Hans": "五小时配额：剩余 {remainingPercent}% · {reset} 后重置",
    es: "Cuota de cinco horas: queda {remainingPercent}% · se reinicia en {reset}",
  }),
  "electron.tray.windowSevenDay": Object.freeze({
    "en-US": "Seven-day allowance: {elapsedPercent}% elapsed · {usedPercent}% used · resets in {reset}",
    "zh-Hans": "七天配额：已过 {elapsedPercent}% · 已用 {usedPercent}% · {reset} 后重置",
    es: "Cuota de siete días: {elapsedPercent}% transcurrido · {usedPercent}% usado · se reinicia en {reset}",
  }),
  "electron.tray.statusStarting": Object.freeze({
    "en-US": "Starting",
    "zh-Hans": "正在启动",
    es: "Iniciando",
  }),
  "electron.tray.statusAnalyzing": Object.freeze({
    "en-US": "Analyzing",
    "zh-Hans": "正在分析",
    es: "Analizando",
  }),
  "electron.tray.statusFresh": Object.freeze({
    "en-US": "Fresh",
    "zh-Hans": "最新",
    es: "Actualizado",
  }),
  "electron.tray.statusStale": Object.freeze({
    "en-US": "Stale",
    "zh-Hans": "已过期",
    es: "Desactualizado",
  }),
  "electron.tray.statusUnavailable": Object.freeze({
    "en-US": "Status unavailable",
    "zh-Hans": "状态不可用",
    es: "Estado no disponible",
  }),
  "electron.tray.allowanceFiveHour": Object.freeze({
    "en-US": "Five-hour allowance: {remainingPercent}% remaining",
    "zh-Hans": "五小时配额：剩余 {remainingPercent}%",
    es: "Cuota de cinco horas: queda un {remainingPercent}%",
  }),
  "electron.tray.allowanceSevenDay": Object.freeze({
    "en-US": "Seven-day allowance: {remainingPercent}% remaining",
    "zh-Hans": "七天配额：剩余 {remainingPercent}%",
    es: "Cuota de siete días: queda un {remainingPercent}%",
  }),
  "electron.tray.refresh": Object.freeze({
    "en-US": "Update Local Usage",
    "zh-Hans": "更新本地使用情况",
    es: "Actualizar uso local",
  }),
  "electron.tray.checkForUpdates": Object.freeze({
    "en-US": "Check for Updates…",
    "zh-Hans": "检查更新…",
    es: "Buscar actualizaciones…",
  }),
  "electron.tray.retry": Object.freeze({
    "en-US": "Retry",
    "zh-Hans": "重试",
    es: "Reintentar",
  }),
  "electron.tray.settings": Object.freeze({
    "en-US": "Settings…",
    "zh-Hans": "设置…",
    es: "Configuración…",
  }),
  "electron.tray.about": Object.freeze({
    "en-US": "About {appName}",
    "zh-Hans": "关于 {appName}",
    es: "Acerca de {appName}",
  }),
  "electron.tray.quit": Object.freeze({
    "en-US": "Quit {appName}",
    "zh-Hans": "退出 {appName}",
    es: "Salir de {appName}",
  }),
});

function canonicalLocale(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

function localeParts(value) {
  const canonical = canonicalLocale(value);
  if (canonical === null) return null;
  const parts = canonical.split("-");
  const language = parts[0].toLowerCase();
  const script = parts.find((part) => /^[A-Za-z]{4}$/u.test(part));
  const region = parts.slice(1).find((part) => /^(?:[A-Za-z]{2}|\d{3})$/u.test(part));
  return {
    canonical,
    language,
    script: script
      ? `${script.slice(0, 1).toUpperCase()}${script.slice(1).toLowerCase()}`
      : null,
    region: region?.toUpperCase() ?? null,
  };
}

function localeValues(value) {
  return Array.isArray(value) ? value : [value];
}

/** Resolve system/desktop preferences to one of the reviewed copy columns. */
export function resolveDesktopLocale(preference = "system", systemLocales = []) {
  const requestedValues = preference === "system" ? localeValues(systemLocales) : [preference];
  for (const value of requestedValues) {
    const parts = localeParts(value === "en" ? "en-US" : value);
    if (parts === null) continue;
    if (SUPPORTED_LOCALES.includes(parts.canonical)) return parts.canonical;
    if (parts.language === "zh"
        && (parts.script === "Hans" || ["CN", "SG"].includes(parts.region))) {
      return "zh-Hans";
    }
    const languageMatch = SUPPORTED_LOCALES.find((locale) => localeParts(locale)?.language === parts.language);
    if (languageMatch) return languageMatch;
  }
  return DEFAULT_LOCALE;
}

export function desktopText(key, values = {}, {
  locale = "system",
  systemLocales = [],
} = {}) {
  const messages = DESKTOP_MESSAGES[key];
  if (!messages) return key;
  const selected = messages[resolveDesktopLocale(locale, systemLocales)] ?? messages[DEFAULT_LOCALE];
  return selected.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu, (token, name) =>
    Object.hasOwn(values, name) && values[name] != null ? String(values[name]) : token);
}

export { DEFAULT_LOCALE as DESKTOP_DEFAULT_LOCALE, DESKTOP_MESSAGES };
