# Esprit compartible

Esta es la edición configurable de Esprit para amigos doctorandos. Trabaja solo
en este repositorio y en los destinos que el usuario haya autorizado.

- Antes de instalar, lee `.claude/skills/instalar-esprit/SKILL.md`.
- Antes de actualizar una instalación, lee `.claude/skills/actualizar-esprit/SKILL.md`.
- Antes de personalizar, lee `.claude/skills/personalizar-esprit/SKILL.md`.
- Configuración: `config/esprit.schema.json`; Rust es la validación definitiva.
- Conserva español, módulos opcionales y atribución «Creada por A.S. Gómez».
- No añadas identidades, rutas, temas de investigación ni cuentas del autor.
  Los enlaces institucionales UAM del módulo opcional Viajes sí son compartidos.
- No modifiques otra edición de Esprit ni reemplaces una app de distinto
  identificador. Este bundle usa `es.asgomez.esprit`.
- Desactivado significa sin lecturas ni llamadas; compruébalo también en Rust.
- Mantén revisión y confirmación antes de mensajes, eventos y escrituras.
- No registres credenciales ni capturas crudas de correo/mensajes.
- Los cambios de estado de investigación requieren una propuesta concreta y
  confirmación; una instalación nunca sobrescribe el trabajo del usuario.
- Usa pruebas con datos ficticios. No ejecutes Login ni integraciones reales
  como prueba sin autorización específica.
- No publiques datos locales. Revisa `git diff --cached` antes de un push.

## Publicar una versión (mantenimiento)

Las instalaciones se actualizan con «actualiza Esprit», que compara con
`origin/main` y con `releases/latest`. Para que una versión nueva llegue a todos:

1. Sube la versión en `package.json`, `package-lock.json` (dos sitios),
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` y la entrada `esprit` de
   `src-tauri/Cargo.lock`. Formato `0.N.0-beta.M`.
2. Añade la entrada al principio de `CHANGELOG.md` y, si cambia algo que el
   usuario note (aspecto, permisos, configuración nueva), un
   `docs/ACTUALIZACION_0_N.md` con compatibilidad macOS/Windows y pasos.
   Los campos de configuración nuevos deben ser opcionales y los módulos
   nuevos empiezan apagados, para que una actualización nunca rompa una
   configuración existente.
3. Valida (`npm test`, `npm run lint`, `cargo test`, pruebas Python, compilación
   y `scripts/smoke_config.py`) e integra en `main`.
4. Etiqueta `v<versión>` y súbela: el workflow «Windows beta» compila el
   instalador y lo publica con `SHA256SUMS.txt` en la Release de esa etiqueta.
   En macOS cada persona compila su copia.
5. Al terminar ese workflow, «Windows update test» instala la Release anterior
   con una configuración sintética, actualiza a `releases/latest` como hace
   `actualizar-esprit` (hash e instalador silencioso) y comprueba la versión,
   la configuración intacta y `--check-config`. Si falla, la Release no está
   lista. También se lanza a mano desde Actions.
