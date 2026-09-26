# Instalación en macOS

La instalación guiada está en `.claude/skills/instalar-esprit/SKILL.md`.

1. Abrir Claude Code y pedirle instalar `https://github.com/AlejandroSGomez/Esprit`,
   leyendo `CLAUDE.md`. El repositorio es público: no requiere cuenta ni invitación.
2. Clonar por HTTPS fuera de carpetas sincronizadas, por ejemplo `~/Developer/Esprit`.
3. Ejecutar `bash scripts/doctor.sh`: Git, herramientas de Xcode, Node ≥22.13,
   npm, Rust/Cargo estable actualizado (al menos 1.89) y Claude Code. Las integraciones restantes son opcionales.
4. Entrevistar al usuario y revisar la configuración antes de guardarla.
5. Preparar el workspace y sus skills sin reemplazar archivos existentes.
6. `npm ci`, `npm run app:build`; validar el bundle y `--check-config`.
7. Instalar y acompañar el primer Login solo cuando el usuario lo solicite.

## Problemas frecuentes

| Síntoma | Acción |
|---|---|
| Repositorio no encontrado | Comprobar la URL pública y la conexión/proxy. No requiere sesión GitHub. |
| Configuración pendiente | Leer el campo que falla, corregir config y recargar. |
| Claude no arranca desde la app | Comprobar ruta absoluta y usar el CLI nativo; el entorno del Dock no hereda el PATH de Terminal. |
| Correo o calendario denegados | Revisar Automatización en Ajustes del Sistema; desactivar el módulo si se prefiere. |
| Mattermost no conecta | Revisar URL, método de acceso, red/VPN y llavero; no pegar secretos en el chat. |
| SSH falla | Revisar alias, VPN, clave y agente; no activar el módulo hasta que la conexión con clave funcione. |
| Compilación interrumpida | Repetir el comando tras resolver el error, conservando la configuración y los datos. |
| Ya existe otra Esprit | Comparar el identificador. No sobrescribir otra edición; instalar esta en `~/Applications/Esprit compartible.app`. |

No se necesita configurar todas las integraciones para empezar. Nunca aceptes
permisos sin entender el acceso solicitado; denegarlos debe permitir continuar
con ese módulo desactivado. El primer build puede tardar varios minutos.
