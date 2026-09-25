# Primera instalación Windows

Esta ruta reemplaza los pasos específicos de macOS. Lee `docs/WINDOWS.md` y
`docs/UAM_GMAIL.md`. Habla en español. Solo Windows x64 está en el alcance de la
beta; no ejecutes Homebrew, Xcode, osascript, security ni comandos del Mac.

1. Detecta Windows y arquitectura. Ejecuta `scripts/doctor.ps1` o localiza Claude,
   Python y Git con `Get-Command`. Verifica que Python no es solo el alias de
   Microsoft Store. Para la beta precompilada no instales Rust/Visual Studio.
2. Conserva la entrevista de identidad, carpeta, proyectos y apariencia de la
   skill. Usa `config/esprit.windows.example.json`, nunca datos del autor.
3. Ofrece Viajes UAM. Explica que puedes ayudar con clúster individualmente, pero
   la integración nativa de clúster/LaTeX aún no está en esta beta Windows.
4. Ofrece Gmail/Calendar para los rituales. Guía al usuario por UAM_GMAIL.md:
   él inicia sesión, revisa el destino y guarda el reenvío. Confirma que desea
   copiar ese correo a su Gmail; no manipules cuentas ni el reenvío implícitamente.
   Si su organización lo bloquea, deja el módulo apagado. No se reenvían enviados.
5. El usuario conecta Google desde Claude web. Claude Code debe usar su cuenta
   Claude, no una API key. Verifica /mcp; recoge los nombres reales de herramientas
   de lectura en read_tools. El ejemplo no es prueba de disponibilidad. No uses
   comodines ni concedas envío/escrituras. Si no puedes verificarlo, conserva
   enabled:false y explica qué falta; el resto de Esprit puede funcionar.
6. Revisa con él la consulta Gmail y los IDs de Google Calendar. Activa solo las
   fuentes verificadas; módulos mail/calendar nativos permanecen apagados.
7. Propón el JSON completo; tras confirmación, guarda con respaldo en
   `%USERPROFILE%/.config/esprit/config.json`. Prepara el workspace y skills como
   en configuracion-y-carpeta.md, sin sobrescribir documentos. Configura rutas
   absolutas a claude.exe y python.exe. Instala `tzdata` para ese Python si falta.
8. Usa la beta publicada del repo privado, verifica que procede de ese repo y
   conserva otras ediciones instaladas. El usuario ejecuta el instalador por
   usuario. No desactives SmartScreen/antivirus. Si necesita compilar, detecta los
   requisitos documentados de Tauri y usa `npm ci; npm run app:build:windows`.
9. Valida `python scripts/check_config.py` y `esprit.exe --check-config`. Abre la
   instalación exacta y comprueba sus proyectos. Login requiere su autorización
   para leer fuentes reales: no lo uses como prueba automática de instalación.
10. Explica los límites (solo lectura de Google, no bandejas completas ni eventos
    nuevos desde Logout). Invita a personalizar y reportar lo que falle.

Para código compartible, consulta la rama/release de la beta, no un binario de
macOS. Revisa conflictos antes de actualizar y no publiques la config del usuario.
