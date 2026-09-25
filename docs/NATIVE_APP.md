# Arquitectura y comprobaciones

Next.js/React exporta una interfaz estática; Tauri 2 sirve esa interfaz en una
app de macOS. Rust valida configuración y acciones. Los puentes Python/JavaScript
leen integraciones desde la configuración transmitida por el proceso nativo.

`src-tauri/src/config.rs` valida proyectos, rutas, módulos y calendarios.
`app/appConfig.ts` recibe solo la configuración apta para mostrar en interfaz.
El identificador de esta edición es `es.asgomez.esprit`; los datos de Tauri se
separan por identificador. La configuración del usuario y su workspace están
fuera del repositorio.

## Validación local sin cuentas reales

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
python3 -m unittest discover -s src-tauri/tests
node --test app/*.test.mjs app/components/*.test.mjs
npm run lint
npm run build
npm run app:build
```

Los tests deben usar fixtures temporales. No ejecutar Login, correo, Mattermost,
SSH ni escrituras de calendario para validar una compilación. Comprueba además
el arranque sin configuración y con módulos apagados antes de una entrega.

La firma local ad hoc no equivale a notarización de Apple. Se compila en el Mac
propio; no se distribuye un DMG. No reemplazar un bundle de otra edición.
