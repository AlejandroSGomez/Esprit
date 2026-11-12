# Validación de la edición compartible 0.5.0-beta.1

Revisión del 12 de noviembre de 2026. Alcance funcional y diferencias entre
plataformas: [actualización 0.5](ACTUALIZACION_0_5.md).

## Pruebas locales (macOS)

- `npm test`: pruebas unitarias y suites DOM, incluidos enlaces Markdown,
  tablas/PDF, pestañas, transferencias revisadas y resumen/bibliografía.
- `npm run lint`, TypeScript y compilación estática Next.js.
- Pruebas Rust completas y 120 pruebas Python con datos ficticios.
- Bundle público Tauri `es.asgomez.esprit` y `scripts/smoke_config.py`.
- Inspección de lectores en WebKit a 1280/760/480 px y de Resumen/Bibliografía
  a 960/360 px: sin desbordamiento horizontal de la ventana. Son fixtures
  sintéticos; no una prueba manual de la interfaz nativa de Windows.
- `npm audit --omit=dev`: sin avisos. La auditoría completa conserva siete
  avisos moderados de la cadena de desarrollo ESLint/TypeScript, derivados de
  `minimatch` y su procesamiento de patrones. No se fuerza el salto de versión
  mayor que aún no adopta esa cadena. No hay avisos altos o críticos.

## Condiciones de publicación Windows

El workflow [Windows beta](../.github/workflows/windows-beta.yml) comprueba:

1. Sintaxis PowerShell, frontend, suites Python portables y pruebas Rust.
2. Compilación Windows x64, instalador NSIS y configuración aislada.
3. Instalación de la beta 0.4 y lectura válida de una configuración ficticia.
4. Actualización al candidato, versión completa y conservación byte a byte de
   configuración, documento de workspace y un archivo de datos de aplicación.
5. Comprobaciones de configuración sobre el ejecutable instalado.

Solo tras esos pasos se publica el instalador con `SHA256SUMS.txt`.
[Windows update test](../.github/workflows/windows-update-test.yml) repite la
actualización desde la descarga pública y verifica su hash. Las notas de la
Release enlazan las ejecuciones correspondientes; una compilación local macOS
por sí sola no valida el instalador Windows.

## Límites de la validación

No se consultan cuentas reales ni se ejecutan Login/Logout, envíos, SSH o cambios
de calendario como pruebas. Los módulos opcionales se prueban con fixtures y
apagados. No se ha validado manualmente la interfaz en el PC de otra persona ni
Windows ARM. La edición personal y su aplicación instalada no se actualizan
con este mantenimiento de la edición pública.

# Histórico: validación 0.2.0-beta.1

Comprobada el 25 de septiembre de 2026. La primera beta se dirige a Windows 11 x64;
el código compartido también se ha verificado en macOS Apple Silicon.

## Windows

- Compilación en GitHub Actions sobre Windows: lint, 23 pruebas Node y 11 pruebas
  Python del lector de conectores con datos ficticios.
- 14 pruebas nativas de zona horaria, configuración portable, bloqueo de archivos,
  herramientas permitidas, historial y notas.
- Compilación Tauri y empaquetado NSIS por usuario.
- Prueba aislada del ejecutable: acepta módulos apagados y Viajes opcional;
  rechaza rutas fuera del workspace y configuración ausente.
- El instalador publicado corresponde al commit comprobado por la ejecución
  enlazada en las notas de la versión. Se acompaña de SHA256SUMS.txt.

[Ejecución comprobada](https://github.com/AlejandroSGomez/Esprit/actions/runs/36167212703),
commit `607d0e7720171238f8bb282f90203193e42e4020`.

## Regresión en macOS

- 145 pruebas Rust, 116 Python y 23 Node superadas.
- ESLint, TypeScript y exportación estática Next.js correctos.
- Compilación Tauri, firma local ad hoc y prueba aislada de configuración del
  bundle `es.asgomez.esprit`, versión 0.2.0-beta.1, correctas.
- Revisión visual de Inicio y Configuración en demostración, incluidos los
  avisos de alcance de Gmail/Calendar. Atajos con indicación Ctrl/⌘.
- Se mantiene un aviso de compilación sobre una función auxiliar de formato
  de fecha sin uso en producción; no afecta al resultado de las pruebas.

## Límites

No se han consultado cuentas reales ni ejecutado un Login/Logout, envíos, SSH o
escrituras de calendario como prueba. Falta la primera instalación manual en
el Windows de otra persona y validar sus conectores con su consentimiento.
No se ha probado la interfaz nativa de Windows manualmente ni Windows ARM.
La compilación automática no garantiza los permisos o integraciones de cada PC.

La beta Google solo lee fuentes para los rituales. No incluye bandeja/agenda
Google interactiva ni escrituras Google; LaTeX aislado y clúster están apagados
en Windows. Las limitaciones del reenvío UAM se explican en UAM_GMAIL.md.
La edición personal del autor y sus datos no se han modificado.

Para repetir la comprobación aislada después de compilar:

```powershell
python scripts/smoke_config.py src-tauri/target/release/esprit.exe
```

```sh
python3 scripts/smoke_config.py src-tauri/target/release/bundle/macos/Esprit.app/Contents/MacOS/esprit
```

La integración continua está en `.github/workflows/windows-beta.yml`.
Más comandos en [NATIVE_APP.md](NATIVE_APP.md).
