# Esprit

**Tu doctorado, en tu Mac. Creada por A.S. Gómez.**

Esprit reúne proyectos, notas, PDFs, chat y los rituales de Login y Logout en una
app local que puedes adaptar a tu manera de investigar. Esta edición se comparte
por un repositorio privado: cada persona compila su propia app y conserva sus
propios datos. La primera versión es para macOS y está en español.

## Instálame esto

Acepta la invitación al repositorio y pasa su enlace a Claude Code:

> Instálame Esprit desde este repositorio. Lee CLAUDE.md y sigue la skill
> .claude/skills/instalar-esprit. Pregúntame qué quiero y adapta la app a mi doctorado.

Claude revisará los requisitos, propondrá una configuración en rondas cortas,
preparará tu carpeta de trabajo sin sobrescribir documentos y compilará la app.
Necesitas acceso a Claude Code; cada motor usa tu propia sesión y sus límites de
uso. Codex es opcional. No se distribuyen claves ni sesiones del autor.

## Elige tus módulos

Siempre: Inicio, proyectos, chat con historial, Login y Logout.
Opcionales: Mail.app, Calendario, Mattermost, GitHub, Biblioteca, Radar de arXiv,
Reuniones, LaTeX, Viajes UAM y un clúster SSH. Lo desactivado no consulta fuentes
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
