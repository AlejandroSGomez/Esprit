# Configuración y workspace

Usa `config/esprit.example.json` como estructura, no como preferencias del usuario.
Recoge solo las respuestas de la entrevista. Explica qué fuentes se consultarán
y muestra módulos, rutas, proyectos, calendarios de escritura y enlaces antes de
pedir confirmación. Credenciales nunca dentro del JSON.

Si existe config, léela, conserva valores no afectados y crea una copia con fecha
antes de cambiarla. Escribe mediante archivo temporal y reemplazo atómico;
permisos 0600. Valida JSON y `scripts/check_config.py --sin-estado`.

Prepara únicamente las carpetas elegidas. Para cada proyecto existente conserva
su STATE.md; si falta, propone `templates/workspace/proyecto-STATE.md` relleno con
lo conocido y lo incierto marcado como pendiente. No inventes progreso.
Rellena `templates/workspace/Esprit/STATE.md` con sus slugs y nombres; respeta
exactamente las claves españolas. El perfil de investigación se obtiene de la
entrevista, nunca de la disciplina del autor.

Crea Biblioteca/colecciones y Viajes solo si se activaron. Viajes empieza vacío:
la app crea su registro al confirmar el primer expediente. No copies expedientes,
correos, estados ni historiales de ninguna otra instalación.

Copia `skills/esprit-login` y `skills/esprit-logout` a `.claude/skills/` del workspace.
Si Codex está activado, copia también ambas a `.agents/skills/` del workspace para
su descubrimiento. Fusiona la plantilla CLAUDE.md con instrucciones existentes
solo después de mostrar el cambio; nunca las reemplaces a ciegas.
Valida de nuevo con `scripts/check_config.py` y corrige incoherencias antes de compilar.
