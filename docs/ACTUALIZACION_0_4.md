# Actualización pública 0.4

La 0.4 trae el rediseño de la interfaz y las mejoras de rendimiento y de
fiabilidad de la edición personal de Esprit. Incluye todo lo de la 0.3 (barra
lateral con iconos, espacios a toda altura, visores y pestañas de proyecto) y
no sustituye configuraciones, proyectos, credenciales ni registros.

Para actualizar basta con decir a Claude Code «actualiza Esprit» (ver
`.claude/skills/actualizar-esprit/SKILL.md`).

## Qué vas a notar

- **Nieve y tinta**: la paleta por defecto (`tinta`) pasa del papel cálido a un
  blanco frío con índigo y coral. Si la tenías elegida, la verás al abrir; las
  otras paletas no cambian. Unos 135 colores que estaban escritos a mano siguen
  ahora la paleta y el modo oscuro.
- **Correo más denso**: una sola cabecera con Redactar y actualizar, la
  distribución en tres iconos en la esquina del lector, filas más compactas y
  sin pies vacíos. Si cierras un correo a medio escribir, «Reanudar borrador»
  lo recupera (solo en memoria).
- **Mattermost** sin la fila duplicada de hilos y con la vista previa de
  Markdown opcional (Aa) para un compositor de una línea.
- **Calendario**: en macOS se leen todas las repeticiones de los eventos
  periódicos (antes solo aparecía el primero de cada serie) y se navega por
  meses, semanas o días deslizando dos dedos en el trackpad.
- **Más fluida**: los espacios ocultos ya no se redibujan con cada cambio, las
  consultas periódicas sin cambios no redibujan nada, Markdown y KaTeX se cargan
  al usarse (arranque más ligero) y las listas de Biblioteca conservan la
  inercia al desplazarse.

## Fiabilidad y seguridad

- El historial del chat ya no deja de guardarse con muchos proyectos
  (más de 16 borradores).
- Un Login, Logout o radar que se queda colgado se detiene a los 30 minutos y
  deja reintentar, en lugar de bloquear los rituales hasta reiniciar.
- «Abrir en su app» solo abre documentos, imágenes y medios; lanzadores,
  scripts e instaladores se abren desde el explorador del sistema.
- Los adjuntos guardados desde Correo o Mattermost llevan la marca de descarga
  del sistema (cuarentena en macOS, Mark of the Web en Windows).
- Si un envío de correo no se confirma a tiempo, Esprit avisa de que puede
  haber salido y de revisar Enviados antes de reintentar.

## Permisos nuevos (macOS)

La primera vez que Esprit lea el calendario, macOS preguntará si puede acceder
a **Calendarios** (acceso completo). Sirve para leer las repeticiones de los
eventos; solo se leen los calendarios de tu configuración y crear eventos sigue
pidiendo tu confirmación. Si lo rechazas, el calendario funciona por la vía
anterior (más lenta) y el espacio explica cómo concederlo después.

## Compatibilidad

| Función | macOS | Windows beta |
| --- | --- | --- |
| Paleta, densidad, rendimiento y correcciones | Sí | Sí |
| Correo con «Reanudar borrador» | Mail.app configurado | Correo como fuente de los rituales, como en 0.3 |
| Repeticiones de eventos y gesto del trackpad | Sí | Calendario como fuente de los rituales, como en 0.3 |
| Marca de descarga en adjuntos | Cuarentena | Mark of the Web |

El espacio Calendario conserva su diseño de la 0.3; la edición de eventos y el
arrastre de la edición personal no forman parte de esta beta.

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

Las pruebas usan datos sintéticos; no se usan cuentas reales.
