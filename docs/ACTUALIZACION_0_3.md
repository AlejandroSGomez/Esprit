# Actualización pública 0.3

Esta actualización lleva los nuevos espacios de lectura y las mejoras de
visualización a la edición configurable. No sustituye configuraciones,
proyectos, credenciales ni registros del usuario. Los módulos nuevos están
apagados por defecto y no consultan el disco cuando están desactivados.

## Compatibilidad

| Función | macOS | Windows beta |
| --- | --- | --- |
| Interfaz, Markdown, HTML, PDF, Office y pestañas | Sí | Sí |
| Notas y Journal Club local | Sí | Sí |
| Biblioteca, fichas y organización de PDFs | Sí | Sí |
| Mattermost: recursos, adjuntos y descargas revisadas | Sí | Sí |
| GitHub y Viajes UAM | Sí | Sí |
| Correo por conversaciones | Mail.app configurado | Fuente de lectura de rituales mediante Claude, como en 0.2 |
| LaTeX, Calendario nativo y clúster | Según módulos configurados | Conserva las restricciones de 0.2 |

El pegado de adjuntos usa los archivos que entrega el webview; en macOS las
copias de Finder pueden necesitar el selector o arrastrar el archivo. No se
incorpora el acceso nativo al portapapeles de la edición personal.

Los libros se muestran hasta 2.000 filas × 120 columnas; no se recalculan las
fórmulas en Esprit. Excel u otra aplicación compatible recalcula al abrir.
DOCX/PPTX muestran el texto; su diseño se consulta en la aplicación externa.

La pregunta rápida abre el chat existente. Las acciones de IA sobre correo y
archivos, grabación/transcripción de reuniones, Gmail interactivo, edición
nativa de eventos y Logout retrospectivo siguen fuera de esta beta pública;
requieren adaptar sus contratos y permisos a la configuración multiplataforma.
La agenda personal, direcciones, canales, máquinas y proyectos del autor nunca
forman parte de la distribución.

## Actualizar una copia personalizada

Sigue `.claude/skills/personalizar-esprit/SKILL.md`: conserva los cambios locales,
compara con el remoto e integra en una rama. No reemplaces `config.json` con el
archivo de ejemplo. El instalador publicado de 0.2 continúa siendo esa versión
hasta que haya una nueva Release; una PR o compilación de CI no lo reemplaza.

## Verificación reproducible

```sh
npm ci
npm run lint
npm test
python3 -m unittest discover -s src-tauri/tests
cargo test --manifest-path src-tauri/Cargo.toml
npm run app:build
python3 scripts/smoke_config.py src-tauri/target/release/esprit
```

Las pruebas usan datos sintéticos. En Windows, el workflow compila el instalador,
comprueba los módulos nativos portables y ejecuta el smoke de configuración.
No se validan cuentas reales ni se envían mensajes como parte de estas pruebas.
