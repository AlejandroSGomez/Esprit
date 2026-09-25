---
name: personalizar-esprit
description: Personaliza o actualiza una instalación existente de Esprit con proyectos, módulos, enlaces, colores, fondo, icono y funciones. Usa instalar-esprit para una primera instalación.
---

# Personalizar Esprit

En Windows lee `docs/WINDOWS.md`; respeta las funciones desactivadas de la beta
y usa `npm run app:build:windows`. No ejecutes comandos específicos de macOS.

Lee `AGENTS.md`, `docs/CONFIGURACION.md` y solo la parte relevante del código.
Identifica el repositorio, la configuración, el workspace y el bundle instalado;
no confundas otra edición de Esprit con esta (`es.asgomez.esprit`).

Entiende el cambio pedido. Para datos configurables, muestra el cambio preciso,
respalda la configuración existente y conserva campos ajenos. Valida con
`scripts/check_config.py` y el binario `--check-config`; recarga desde la app.
No necesitas recompilar proyectos, enlaces ni módulos.

Para código, colores o icono, trabaja en una rama local `mi-esprit`, conservando
cambios existentes. Guarda imágenes propias en `public/custom/`. Ejecuta pruebas
proporcionadas al cambio, compila y comprueba el resultado visual. Antes de
reemplazar una app, verifica su identificador y pide confirmación si está en uso.
No modifiques otra instalación ni los documentos de investigación por accidente.

Para actualizar desde el autor: consulta `git status`, revisa commits y cambios
locales; crea un respaldo o commit local revisado antes de integrar. Trae cambios
del remoto existente, resuelve conflictos conservando las personalizaciones y
vuelve a validar. No uses reset --hard, clean ni force-push. Si el usuario solo
pregunta por actualizaciones, informa antes de aplicarlas.

Clúster: explica que puedes ayudar, pero pide alias/centro, requisitos de VPN,
autenticación, rutas y gestor de colas. Comprueba primero una conexión de lectura
con clave pública autorizada. No instales software remoto ni lances trabajos
como parte implícita de configurar Esprit. Si falta acceso, deja el módulo apagado.

Al terminar, explica qué cambió y dónde; propone mejoras pertinentes a su uso,
sin inventar tareas ni activar integraciones no solicitadas.
