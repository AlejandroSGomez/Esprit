# Perfil de investigación para el Radar de lectura

> Esprit lo lee tras cada Login para decidir cuáles de los artículos nuevos de
> arXiv merecen tu atención. Las categorías y palabras clave de la búsqueda
> están en la configuración (`modules.paper_radar`); este perfil decide qué se
> recomienda de entre los candidatos. Escríbelo con frases concretas y cámbialo
> cuando cambien tus prioridades. Última revisión: {{FECHA}}.

## En una frase

{{resumen_investigacion}}

## Prioridad A — trabajo activo

<!-- esprit:perfil-proyecto: un bloque por proyecto activo -->
### `{{slug}}` — {{nombre}}

- Pregunta que intento responder: {{pregunta}}
- Sistemas, modelos o datos: {{sistemas}}
- Métodos y técnicas: {{metodos}}
- Un artículo me sirve si: {{criterio}}
<!-- /esprit:perfil-proyecto -->

## Prioridad B — próximos pasos y direcciones futuras

- {{direcciones_futuras}}

## Prioridad C — interés general

Solo si la conexión con un proyecto es muy directa.

- {{interes_general}}

## Métodos y herramientas que me interesan aunque cambie de tema

- {{metodos_transversales}}

## Falsos positivos frecuentes (no recomendar)

- Artículos que solo comparten palabras clave con mis proyectos, sin un mecanismo o método transferible.
- {{falsos_positivos}}
