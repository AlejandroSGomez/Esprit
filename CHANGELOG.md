# Cambios

## 0.4.0-beta.1 — rediseño, rendimiento y actualizaciones

- Paleta **Nieve y tinta** por defecto (`tinta`): blanco frío, índigo y coral,
  con barra lateral índigo profundo; unos 135 colores escritos a mano pasan a
  los tokens de la paleta, así que todas las paletas y el modo oscuro se
  aplican a toda la interfaz.
- Correo compacto: cabecera única con Redactar y actualizar, distribución en
  iconos, filas de unos 69 px, mensajes sin marco, pies solo con avisos y
  «Reanudar borrador» al cerrar un mensaje sin enviar. Mattermost sin fila de
  hilos duplicada y con vista previa de Markdown opcional. GitHub, Viajes,
  Configuración y Proyectos sin pies vacíos.
- Calendario (macOS): lectura con EventKit, que incluye cada repetición de los
  eventos periódicos; sin acceso completo, AppleScript expande las series con
  `calendar_recurrence.js`. Identificadores únicos por repetición y gesto de
  dos dedos para cambiar de mes, semana o día.
- Rendimiento: espacios ocultos sin re-renders, consultas sin cambios que no
  redibujan, formateadores de fecha compartidos en Mattermost, carga diferida
  de Markdown/KaTeX, sin la importación de Tailwind y desplazamiento estable en
  Biblioteca.
- Fiabilidad: el historial de chat admite hasta 64 borradores (antes fallaba
  con más de 16), los rituales y el radar tienen un límite de 30 minutos que
  detiene el proceso colgado, «Abrir en su app» usa una lista de formatos
  permitidos, los adjuntos guardados llevan la marca de descarga del sistema y
  un envío de correo sin confirmar avisa de que puede haber salido.
- Nueva skill `actualizar-esprit`: «actualiza Esprit» localiza la instalación,
  resume las novedades, conserva configuración, rama `mi-esprit` y skills, y
  recompila (macOS) o instala la última Release verificada (Windows). Cada
  etiqueta `v*` publica el instalador de Windows con `SHA256SUMS.txt`.

## 0.3.0-beta.1 — interfaz y lectura

- Barra lateral compacta con iconos, pregunta rápida con Ctrl/⌘J y espacios
  a toda altura; conserva colores, tema y configuración de cada usuario.
- Proyectos: hasta ocho pestañas por proyecto con borradores independientes,
  ordenación por nombre/tipo/tamaño, menús de archivo e importación revisada.
- PDF: dos páginas, índice, modo noche, búsqueda y progreso recordado.
- Markdown: tablas alineadas a todo el ancho, desplazamiento horizontal y
  edición explícita sin reescribir el texto original.
- HTML aislado con acceso HTTPS opcional; XLSX/XLSM editables, CSV/TSV en tabla
  y extracción de texto de DOCX/PPTX. Los cambios de hojas se revisan antes
  de guardar y los libros con fórmulas no compatibles quedan en lectura.
- Biblioteca: etiquetas, leído/pendiente, notas y ficha del radar; importar,
  renombrar y mover PDFs conservando los vínculos de Journal Club.
- Notas y Journal Club opcionales, vacíos al empezar y apagados por defecto.
  Notas pendientes se incorporan al Logout; Journal Club conserva borradores,
  notas por paper, PDFs vinculados y exportación Markdown revisada.
- Correo por conversaciones con citas y firmas plegables. Mattermost añade
  adjuntos/enlaces por canal, vista previa del compositor y descarga revisada
  a una carpeta de proyecto. GitHub y Viajes usan barras y listas compactas.
- Catálogo de modelos actualizado y migración de selecciones retiradas.

La numeración pública es independiente de la edición personal. Consulta
[alcance y validación](docs/ACTUALIZACION_0_3.md) para las diferencias de plataforma.

## 0.1.0 — edición compartible

Configuración por usuario y módulos opcionales. Instalación mediante entrevista,
plantillas de workspace y personalización con Claude. Viajes UAM opcional con
registro propio; clúster asistido. Identificador independiente `es.asgomez.esprit`.

## 0.2.0-beta.1

- Primera beta Windows x64 con instalador NSIS y compilación CI.
- Fechas IANA, apertura de archivos, exportaciones y bloqueo de registros portables.
- Gmail/Calendar de Claude como fuentes de lectura explícitas de los rituales.
- Guía UAM → Gmail, instalación Windows y credenciales Mattermost nativas.
- LaTeX y clúster nativos pendientes en Windows; macOS conserva sus módulos.
