# Leer en Esprit el correo UAM reenviado a Gmail

El usuario decide si quiere copiar sus nuevos correos UAM a su cuenta Gmail.
Esprit consulta después esa cuenta a través del conector de Claude; no accede a
Outlook ni configura el reenvío por su cuenta. No pidas credenciales en el chat.

## 1. Activar el reenvío en Outlook web

1. Abre [Outlook web](https://outlook.office.com/mail/) e inicia sesión con tu
   cuenta UAM. Comprueba el nombre y la dirección de la cuenta arriba a la derecha.
2. Abre **Configuración** (engranaje) → **Correo** → **Reenvío**. En algunas
   versiones se llama **Reenvío e IMAP**; puedes buscar «reenvío» en Configuración.
3. Activa **Habilitar reenvío** e introduce exactamente tu dirección Gmail.
4. Marca **Conservar una copia de los mensajes reenviados** para mantener los
   originales en el buzón UAM.
5. Revisa dirección y opción de conservar copia; guarda tú el cambio.

Si el menú no aparece o un mensaje devuelve **5.7.520 / Your organization does
not allow external forwarding**, la organización está bloqueando el reenvío.
Consulta al soporte de la UAM; no intentes sortearlo con reglas alternativas.
Deja Gmail desactivado en Esprit hasta disponer de una ruta autorizada que funcione.
No damos por comprobado que la política de la UAM lo permita para todas las cuentas.

## 2. Comprobar y separar los mensajes UAM en Gmail

1. Haz que llegue un correo nuevo de prueba a UAM. Comprueba que está tanto en
   Outlook como en Gmail; revisa Spam si falta. No declares el reenvío listo antes.
2. Abre los detalles del mensaje en Gmail y comprueba qué destinatario conserva.
3. Si conserva tu dirección UAM, usa las opciones de búsqueda de Gmail y pon esa
   dirección en **Para**. Comprueba los resultados antes de crear el filtro.
4. Selecciona **Crear filtro** → **Aplicar la etiqueta** → crea/elige **UAM**.
   No actives borrar ni saltar Recibidos. Puedes aplicar la etiqueta a las
   coincidencias que ya estén en Gmail si quieres incluirlas.
5. Verifica que otro mensaje nuevo recibe la etiqueta. Si el reenvío no conserva
   el destinatario esperado, revisa los encabezados de un ejemplo con el usuario
   y define un filtro que realmente identifique esos mensajes; no uses uno que
   mezcle todo su correo personal por comodidad.
6. La consulta inicial de Esprit será `label:UAM newer_than:7d`.

## 3. Conectar Claude

En Claude → Conectores, conecta Gmail con esa misma cuenta Google. Completa
[los pasos de Windows](WINDOWS.md#conectar-gmail-y-google-calendar) y confirma la
consulta antes de activar la fuente en Esprit.

## Qué incluye y qué no

- Incluye los nuevos mensajes recibidos que efectivamente se reenvíen y coincidan
  con la consulta, dentro de la ventana y los límites de la captura.
- No importa retroactivamente el historial anterior de Outlook.
- No copia los **Enviados de Outlook**. Tampoco sincroniza leídos, carpetas o borrados.
- No conecta el calendario UAM: Google Calendar se configura por separado.
- Responder desde Gmail no garantiza enviar con tu identidad UAM. Esta beta no
  envía correos: responde desde Outlook para conservar tu cuenta institucional.

Fuentes oficiales consultadas para estos pasos:
[Microsoft: activar el reenvío](https://support.microsoft.com/en-gb/outlook/mail/turn-automatic-forwarding-on-or-off-in-outlook),
[Microsoft: restricciones y error 5.7.520](https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding),
[Google: filtros de Gmail](https://support.google.com/mail/answer/6579).
