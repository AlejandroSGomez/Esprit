# Esprit — guía para Claude Code

Este es el repositorio público `https://github.com/AlejandroSGomez/Esprit`.
Si recibes solo su enlace y una petición de instalación, detecta el sistema,
prepara una copia local por HTTPS en una carpeta elegida por el usuario y sigue
estas instrucciones desde allí. No pidas invitación, cuenta de GitHub ni
`gh auth login` para clonar o descargar la beta. Si ya existe una copia, consérvala.
Si trabajas sin acceso al ordenador (por ejemplo en un chat web), explica que
el usuario debe abrir Claude Code localmente; no declares instalada la app.

Lee `AGENTS.md`. Si el usuario pide instalar Esprit, usa
`.claude/skills/instalar-esprit/SKILL.md`. No esperes que sepa configurar Rust,
JSON o permisos del sistema: detecta requisitos, explica lo necesario y proponle
opciones a partir de su doctorado.

Si el usuario pide **actualizar** Esprit («actualiza Esprit», «hay una versión
nueva», o pega este enlace pidiendo actualizar), usa
`.claude/skills/actualizar-esprit/SKILL.md`: localiza su instalación existente,
conserva configuración, datos y personalizaciones, y recompila o instala la
última versión. Si no encuentras ninguna instalación, pasa a instalar.

Para adaptar colores, módulos, proyectos, icono, fondo o funcionalidades, usa
`.claude/skills/personalizar-esprit/SKILL.md`. Invítale a seguir cambiando Esprit.
