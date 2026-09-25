# Configuración

Archivo local: `~/.config/esprit/config.json`. `ESPRIT_CONFIG` permite elegir otro
archivo, por ejemplo para pruebas. Copia y adapta `config/esprit.example.json`;
el contrato completo está en `config/esprit.schema.json`.

- `user`: nombre visible, nombre corto e iniciales.
- `time_zone`: zona IANA usada en fechas y calendario.
- `workspace`: carpeta raíz existente; `source_repo`: carpeta del código.
- `tools`: rutas absolutas a Claude, Codex, gh, Python y latexmk. Una herramienta
  opcional puede ser null. No pongas tokens ni argumentos en estas rutas.
- `projects`: slug único, nombre y carpeta relativa existente. Opcionalmente repos
  GitHub, colección bibliográfica y directorio relativo del clúster.
- `links`: aplicación o URL de un esquema permitido, etiqueta e icono.
- `milestones`: título, fecha ISO y detalle opcional.
- `appearance`: paleta inicial, claro/oscuro y activación de fondo propio.
- `modules`: cada módulo tiene `enabled`. Ausente o false significa desactivado.

## Integraciones

Mail usa cuentas ya configuradas en Mail.app; solo se incluyen las elegidas.
Calendar permite leer nombres configurados y escribir en un subconjunto explícito.
Mattermost recibe servidor, equipo, usuario y nombre del elemento del llavero;
la contraseña/token queda en el llavero. GitHub usa `gh` y los repos declarados.
Biblioteca usa una carpeta relativa al workspace. Radar añade categorías arXiv,
palabras clave y un perfil propio, sin criterios disciplinares del autor.
Viajes usa `modules.travel: {"enabled": true, "folder": "Viajes"}`; crea esa
carpeta al configurar el módulo. No copies registros de otra persona.
Clúster usa alias SSH, raíz remota, etiqueta y `scheduler: "slurm" | "none"`.
Cada entorno debe verificarse por separado; Claude puede ayudar a prepararlo.

## Verificación

`python3 scripts/check_config.py /ruta/config.json` hace la comprobación previa.
`Esprit.app/Contents/MacOS/esprit --check-config` realiza la validación nativa
(usando `ESPRIT_CONFIG` si procede). Revisa el resumen antes de activar módulos.
No versionar configuraciones personales ni carpetas de trabajo.

## Beta Windows y conectores Claude

Usa `config/esprit.windows.example.json`. `modules.claude_connectors` contiene
`enabled`, `gmail`, `calendar`, `gmail_query`, `calendar_ids` y `read_tools`. Los
nombres MCP son concretos y se verifican en la cuenta del usuario; Rust rechaza
comodines y operaciones de escritura. El módulo no añade bandejas interactivas.
Consulta [WINDOWS.md](WINDOWS.md) antes de activar fuentes; no se pueden activar
al mismo tiempo la fuente nativa y la de conectores para el mismo servicio.
