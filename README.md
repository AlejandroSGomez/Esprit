# Esprit

**Tu doctorado, en tu ordenador. Creada por A.S. Gómez.**

Esprit reúne proyectos, notas, PDFs, chat y los rituales de Login y Logout en una
app local que puedes adaptar a tu manera de investigar. Esta edición se comparte
desde este repositorio público: cada persona conserva sus propios datos.
Disponible para macOS y como primera beta Windows x64, en español.

**Windows:** empieza por [la guía de la beta](docs/WINDOWS.md). Gmail y Google
Calendar son fuentes de lectura de los rituales; [UAM → Gmail](docs/UAM_GMAIL.md)
explica cómo preparar el reenvío desde Outlook y comprobar su alcance.

## Instálame esto

Copia este mensaje en **Claude Code en tu ordenador**:

```text
Instálame Esprit desde https://github.com/AlejandroSGomez/Esprit.
Lee primero CLAUDE.md y sigue .claude/skills/instalar-esprit/SKILL.md.
Detecta si uso Windows o macOS, comprueba los requisitos y guíame.
Pregúntame qué proyectos y módulos quiero y adapta la app a mi doctorado.
```

No necesitas invitación ni cuenta de GitHub para descargar el código o la beta.
Claude puede clonar el repositorio público por HTTPS. Si usas una copia ZIP,
descomprímela y abre Claude Code dentro de la carpeta `Esprit`.

| Sistema | Instalación |
|---|---|
| **Windows 11 x64** | [Instalador `.exe` de la beta](https://github.com/AlejandroSGomez/Esprit/releases/tag/v0.2.0-beta.1); Claude configura tus proyectos y cuentas. No requiere Rust ni Visual Studio. |
| **macOS** | Claude comprueba las herramientas, compila la app en tu Mac y la instala. No se distribuye una app Mac precompilada. |

Claude revisará los requisitos, propondrá una configuración en rondas cortas,
preparará tu carpeta de trabajo sin sobrescribir documentos e instalará la beta
de Windows o compilará la app según tu sistema.
Necesitas acceso a Claude Code; cada motor usa tu propia sesión y sus límites de
uso. Codex es opcional. No se distribuyen claves ni sesiones del autor.

## Elige tus módulos

Siempre: Inicio, proyectos, chat con historial, Login y Logout.
Opcionales: Mail.app, Calendario, Mattermost, GitHub, Biblioteca, Radar de arXiv,
Notas, Journal Club, Reuniones, LaTeX, Viajes UAM y un clúster SSH. Lo desactivado no consulta fuentes
ni aparece como un fallo de cobertura.

Viajes conserva el flujo y enlaces de la UAM; tus expedientes empiezan vacíos.
El clúster requiere adaptación: VPN, claves, directorios y gestor de colas dependen
de cada centro. Claude puede ayudarte a prepararlo; no necesitas configurarlo
para usar el resto de Esprit.

## Hazlo tuyo

Elige colores, enlaces, fondo e icono. Para cambios posteriores, abre Claude Code
en este repositorio y pide usar `.claude/skills/personalizar-esprit`.
Las preferencias viven en `~/.config/esprit/config.json`; proyectos, estados y
biblioteca viven en tu workspace. Ninguno debe subirse a este repositorio.

- [Instalación y problemas habituales](docs/INSTALACION.md)
- [Configuración](docs/CONFIGURACION.md)
- [Uso diario](docs/USO.md)
- [Personalización y actualizaciones](docs/PERSONALIZACION.md)
- [Arquitectura](docs/NATIVE_APP.md)
- [Pruebas realizadas y límites de esta beta](docs/VALIDACION.md)

Las acciones de enviar correo o mensajes, escribir archivos y crear eventos
requieren revisión y confirmación en la app. Esprit no presenta un trámite UAM ni
una reserva por ti. El radar puede recomendar cero artículos: no rellena cuotas.

- [Novedades de la beta 0.3](docs/ACTUALIZACION_0_3.md)
