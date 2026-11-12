# Actualización pública 0.5

Esta beta adapta las mejoras portables de la edición personal revisadas hasta
la 0.58. Su numeración es independiente. No necesita campos de configuración
nuevos, no activa módulos y no migra ni sobrescribe los documentos del usuario.

Para actualizar, dile a Claude Code:

```text
Actualiza Esprit desde https://github.com/AlejandroSGomez/Esprit.
```

Windows descarga el instalador de la última Release y comprueba su SHA256.
En macOS se compila la copia propia. La actualización conserva configuración,
workspace, credenciales y personalizaciones según la skill `actualizar-esprit`.

## Qué cambia

### Proyectos

Al entrar aparece **Resumen**: el estado propio del proyecto, su foco y siguiente
paso. `STATE.md` se muestra sin reescribirlo. **Abrir archivo** lleva al visor y
editor habitual, con guardado revisado. Un proyecto sin ese archivo puede seguir
usándose; Esprit no lo crea por su cuenta.

Con Biblioteca activada, **Bibliografía** reúne los PDFs etiquetados con el slug
del proyecto o guardados en su colección. Permite buscarlos y leerlos allí,
poniendo primero los pendientes. Las etiquetas y notas se gestionan en Biblioteca.
Con el módulo apagado no se consulta el catálogo.

En **Explorador** puedes seleccionar varios elementos con Ctrl/⌘, copiar archivos
o cortar archivos/carpetas y pegarlos en otra carpeta del mismo proyecto. Los
atajos son Ctrl/⌘C, X y V; también hay menú contextual. Arrastrar una selección
sobre una carpeta o una ruta de navegación propone moverla.

Siempre se revisa la selección y el destino antes de escribir. No se reemplazan
nombres existentes; si falla parte de una operación se informa qué terminó.
Límites: 50 elementos por operación y 80 MB por selección de copia. Copiar carpetas,
copiar entre proyectos y usar el portapapeles del sistema quedan fuera de esta
beta. Para esos casos usa el explorador de archivos del sistema.

### Lectura

- Enlaces web en Markdown y notas, abiertos mediante el puente de Esprit.
- En Proyectos, enlaces relativos a otros documentos dentro de la misma raíz.
- Anclas dentro del documento actual. Un enlace a otro archivo con fragmento
  abre ese archivo y avisa para buscar la sección; todavía no salta a ella.
- Tablas con desplazamiento horizontal propio y pestañas que no ensanchan la
  ventana. Barras del lector adaptables sin solapamientos.

Los visores PDF, HTML y Office de la 0.3 se conservan; esta beta no cambia el
motor PDF ni añade una suite Office completa.

### Mattermost

La primera lectura obtiene los últimos 80 mensajes y las raíces necesarias para
sus hilos. **Cargar historial** mantiene el acceso ampliado bajo demanda.
Una caché de hasta 12 canales en RAM permite mostrar la última lectura al cambiar
de canal, mientras se actualiza. La precarga está limitada y las peticiones
duplicadas comparten una lectura. No guarda conversaciones nuevas en disco.

El último canal se recuerda por servidor, equipo y usuario. Las menciones a tu
usuario y al canal se destacan. Las respuestas tardías de otra selección no
sustituyen el canal actual y los mensajes borrados en la ventana reciente no
reaparecen al refrescar el historial ampliado.

## Compatibilidad y selección de mejoras

| Cambio revisado de la edición personal | macOS público | Windows público |
| --- | --- | --- |
| Resumen STATE y bibliografía por proyecto | Incluido | Incluido |
| Copiar/cortar/pegar y arrastre interno | Incluido | Incluido, Ctrl y rutas nativas |
| Enlaces, tablas y barras de lectura | Incluido | Incluido |
| Caché, carga reciente y menciones Mattermost | Incluido con configuración propia | Incluido con configuración propia |
| Chat rápido e historial público existentes | Se conservan | Se conservan |
| Koi completo: sesiones de CLI, importación, herramientas y aprobaciones | Pendiente de adaptación pública | Pendiente de adaptación pública y de procesos Windows |
| Edición avanzada de calendario y nuevos flujos de correo personales | No se trasladan en esta beta | Gmail/Calendar siguen como fuentes de los rituales |
| Logout personal por operaciones y seguimiento automático de cambios STATE | Pendiente de un contrato público propio | Pendiente de un contrato público propio |
| Sincronización iCloud/iOS, servicios y automatizaciones personales | No se incluyen | No aplican |

Koi requiere una adaptación separada: ejecución de procesos, permisos, sesiones
de cada proveedor y recuperación deben funcionar con las cuentas y herramientas
de cada persona. La app pública conserva su chat actual; esta versión no promete
la equivalencia completa con Koi.

Gmail y Google Calendar en Windows **no son una bandeja ni una agenda interactiva**.
Siguen siendo fuentes de lectura de Login/Logout a través de los conectores del
usuario. Mail.app/EventKit siguen disponibles en macOS. LaTeX aislado y el clúster
nativo de Windows continúan pendientes.

## Comprobaciones

Las pruebas usan datos ficticios: frontend, enlaces y transferencias, contratos
nativos y Python, compilación y configuración. El flujo de Windows instala la
0.4, crea configuración, documentos y datos de aplicación sintéticos, instala
el candidato y comprueba su versión y que esos archivos mantienen sus hashes.
Esa comprobación debe pasar antes de publicar. Después se verifica también el
instalador descargado desde la Release pública y su checksum.

No se prueban cuentas reales, envíos, rituales ni permisos de otras personas.
La validación automática Windows x64 no sustituye una prueba de interfaz en el
PC de cada usuario ni valida Windows ARM. Véase [validación](VALIDACION.md).
