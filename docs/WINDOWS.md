# Esprit para Windows — primera beta

Esta edición usa el mismo repositorio compartible. No modifica otra instalación
personal de Esprit. El objetivo inicial es Windows 11 x64 con Claude Code nativo.

## Incluido

Inicio, proyectos, notas, Markdown/PDF, chat e historial, skills, Login/Logout,
Biblioteca y Radar, Reuniones y Viajes UAM opcional. GitHub y Mattermost son
opcionales; requieren sus herramientas/cuentas. Gmail y Google Calendar se leen
mediante los conectores de Claude al iniciar cada ritual, con una captura nueva
que se reutiliza durante las dos fases del Logout.

## Límites de esta beta

- Gmail/Calendar son fuentes de los rituales. No hay bandeja de correo ni agenda
  interactiva de Google en Esprit todavía; se abren sus webs desde los accesos.
- Los conectores son solo de lectura: no envían correo ni crean o modifican
  eventos. Logout puede guardar el estado global tras revisión, pero devuelve
  propuestas de calendario vacías mientras el calendario nativo está apagado.
- La captura usa Claude aunque el modelo elegido para redactar el ritual sea
  Codex (en ese caso, la lectura usa Sonnet). Añade una consulta a la cuenta de
  Claude y puede tardar hasta cuatro minutos. No hay consultas periódicas.
- LaTeX aislado y clúster están desactivados en Windows por ahora. Se conservan
  Overleaf y otros enlaces; su integración nativa requiere otra fase.
- La versión x64 no supone validación nativa de Windows ARM. Las pruebas de CI
  no sustituyen la primera instalación acompañada y el uso con cuentas reales.

## Instalar con Claude

Pega en Claude Code `https://github.com/AlejandroSGomez/Esprit` y pide
lo siguiente. No hace falta invitación ni cuenta de GitHub:

> Instálame Esprit en Windows. Lee CLAUDE.md y la skill instalar-esprit.
> Sigue su referencia windows.md y pregúntame qué módulos quiero.

La configuración vive en `%USERPROFILE%\.config\esprit\config.json`.
Usa `config/esprit.windows.example.json` como estructura y sustituye todas las
rutas y los datos de ejemplo por los del usuario. Es más sencillo escribir rutas
JSON con `/`, por ejemplo `C:/Users/Ana/Doctorado`.

La beta precompilada usa un instalador `.exe` por usuario, sin necesitar Rust o
Visual Studio en el PC del destinatario. El motor Claude y Python sí deben
estar instalados y configurados. No se distribuyen cuentas ni credenciales.
Para compilar desde el código se necesitan Node 22+, Rust estable, herramientas
C++ de Visual Studio y WebView2; ejecuta `npm ci` y `npm run app:build:windows`.
El instalador sale en `src-tauri/target/release/bundle/nsis/`.

El ejecutable permite comprobar la configuración sin Login:
`esprit.exe --check-config`. La primera apertura sin config muestra el asistente
«Configuración pendiente». No pulses Login hasta verificar cuentas y fuentes.

## Conectar Gmail y Google Calendar

1. Sigue [la guía UAM → Gmail](UAM_GMAIL.md) y verifica un mensaje nuevo.
2. En Claude, abre Personalizar/Configuración → Conectores. Conecta **Gmail** y
   **Google Calendar** con la cuenta Google elegida. El usuario inicia sesión y
   acepta los permisos; nunca pega contraseñas, tokens ni códigos en el chat.
3. En Claude Code, inicia sesión con la misma cuenta de Claude. Usa `/mcp` para
   comprobar los conectores. No basta una clave de API o un token `setup-token`.
4. Comprueba los nombres completos de las herramientas de lectura que expone
   esa versión del conector. El ejemplo incluye nombres habituales, pero deben
   verificarse, no inventarse. `read_tools` contiene nombres concretos, sin `*`,
   solo búsquedas/lecturas de mensajes y listas/lecturas de eventos. Nunca envío,
   borrado, etiquetas, creación o modificación.
5. Configura `gmail_query` con el filtro confirmado, por ejemplo
   `label:UAM newer_than:7d`. Configura los IDs de los calendarios que quiere leer;
   `primary` significa el principal de esa cuenta Google, no el calendario UAM.
6. Solo después de verificarlos, activa `modules.claude_connectors.enabled` y
   Gmail y/o Calendar. Mantén `modules.mail` y `modules.calendar` apagados.
7. Con autorización del usuario, ejecuta un Login. Si aparece cobertura parcial,
   revisa qué conector falta. Esprit no considera un fallo una bandeja vacía.

No se copian eventos Outlook al reenviar correo. Los eventos que quiera consultar
Esprit deben existir en un calendario al que acceda esa cuenta Google. Tampoco
se incluyen correos anteriores ni enviados desde Outlook por el mero reenvío.

## Mattermost y GitHub opcionales

GitHub usa `gh.exe` autenticado por el propio usuario y Git para Windows.
El acceso visible de autenticación de la app sigue siendo macOS: en Windows haz
`gh auth login --web` desde la Terminal antes de activar el módulo.

Mattermost usa el Administrador de credenciales de Windows. Tras configurar
servidor, equipo, usuario y `keychain_service` (nombre estable del servicio), el
usuario ejecuta `python scripts/windows-mattermost.py` en su Terminal. El secreto
se introduce oculto y se guarda como `Esprit/<servicio>/<usuario>`, nunca en JSON.
Para abrir Mattermost, usa su URL en los accesos; no un nombre de app de macOS.

## Pruebas y diagnóstico

`powershell -File scripts/doctor.ps1` detecta herramientas sin autenticarse.
La compilación CI **Windows beta** genera un artefacto `Esprit-Windows-beta`.
La beta se descarga de [Releases](https://github.com/AlejandroSGomez/Esprit/releases/tag/v0.2.0-beta.1), sin iniciar sesión.
No desactives protecciones de Windows para instalar. Si el instalador sin firma
comercial es bloqueado, revisa el origen con el usuario o usa la compilación local.

Fuentes: [Tauri en Windows](https://v2.tauri.app/start/prerequisites/),
[conectores de claude.ai en Claude Code](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claudeai).
