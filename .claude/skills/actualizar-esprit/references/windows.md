# Actualizar Esprit en Windows

Sustituye el paso 5 de la skill. No ejecutes comandos de macOS (osascript,
codesign, ditto, Homebrew). Usa PowerShell.

## Con el instalador (lo habitual)

1. Lee la última Release sin iniciar sesión:
   `Invoke-RestMethod https://api.github.com/repos/AlejandroSGomez/Esprit/releases/latest`.
   Comprueba que su versión es mayor que la instalada (Configuración → Acerca
   de, o `Get-ItemProperty` de la entrada «Esprit» en
   `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*`).
2. Descarga a la carpeta de Descargas el `Esprit_*_x64-setup.exe` y el
   `SHA256SUMS.txt` de esa Release. Comprueba el hash con
   `Get-FileHash -Algorithm SHA256` y compáralo con la línea del archivo. Si no
   coincide, no lo ejecutes: avisa y detente.
3. Pide a la persona que cierre Esprit y ejecute ella el instalador (es por
   usuario y conserva configuración y datos). No desactives SmartScreen ni el
   antivirus; si SmartScreen avisa, explica que la beta no está firmada con un
   certificado comercial y que puede comprobar el hash antes de continuar.
4. Valida: `python scripts\check_config.py` si hay clon, y `esprit.exe
   --check-config` en la carpeta de instalación (por defecto
   `$env:LOCALAPPDATA\Esprit`; confírmala con `InstallLocation` en la entrada de
   desinstalación del registro).
5. Actualiza las skills del workspace como en el paso 4 de la skill si hay clon;
   sin clon, descarga solo la carpeta `skills/` de la Release (código fuente ZIP)
   y compárala igual, con respaldo y confirmación.

## Si mantiene cambios de código

Integra como en el paso 3 de la skill y compila localmente:
`npm ci; npm run app:build:windows`. Requiere los requisitos de Tauri para
Windows (Rust, Visual Studio Build Tools, WebView2); detecta qué falta antes de
instalar nada y pide confirmación. El instalador queda en
`src-tauri\target\release\bundle\nsis\`; la persona lo ejecuta.

## Si la Release todavía no tiene instalador

El instalador lo construye el workflow «Windows beta» al publicar una etiqueta
`v*`. Si la última Release no lo incluye aún, dilo, ofrece esperar o compilar
localmente, y no uses artefactos de una PR como si fueran una versión publicada.
