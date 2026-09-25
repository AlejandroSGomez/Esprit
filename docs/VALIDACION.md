# Validación de la edición compartible 0.2.0-beta.1

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
