# Compilar e instalar

Desde la raíz del repo: `npm ci` y `npm run app:build`. Si falla, lee el error,
resuelve la causa y repite; no declares instalada una compilación fallida.
El bundle se genera en `src-tauri/target/release/bundle/macos/Esprit.app`.
Comprueba Info.plist: identificador `es.asgomez.esprit` y versión coherente con
package.json y Cargo.toml. Firma localmente con `codesign --force --deep --sign -`
y comprueba `codesign --verify --deep --strict`.

Ejecuta el binario del bundle con `--check-config` y `ESPRIT_CONFIG` apuntando al
archivo que acabas de preparar. Es una validación local; no inicia un Login.

Destino habitual `/Applications/Esprit.app`. Si existe, lee su identificador.
Si es otra edición, **no la reemplaces**: propone `~/Applications/Esprit compartible.app`
y confirma el destino. Si es esta edición, confirma el reemplazo y cierra la app
conservando trabajo pendiente antes de copiar mediante `ditto`.

Verifica versión, firma y recursos tras copiar. Abre exactamente el bundle de
destino. Comprueba nombre, proyectos y módulos antes de acompañar al usuario al
primer Login. Si este no quiere ejecutarlo aún, deja la app lista sin hacerlo.
No borres el bundle generado ni otras instalaciones como parte de la instalación.
