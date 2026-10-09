#!/usr/bin/env python3
"""Prueba aislada del contrato de configuración; nunca consulta integraciones."""
import json, os, subprocess, sys, tempfile
from pathlib import Path

binary = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='esprit-smoke-') as tmp:
    root = Path(tmp).resolve()
    workspace = root / 'Doctorado'
    for folder in ['Proyectos/Tesis', 'Proyectos/Articulo-1', 'Esprit', 'Viajes']:
        (workspace / folder).mkdir(parents=True, exist_ok=True)
    config = json.loads((repo / 'config/esprit.example.json').read_text())
    config.update(workspace=str(workspace), source_repo=str(repo))
    config['tools'] = {'claude': sys.executable, 'codex': None, 'gh': None, 'python3': sys.executable, 'latexmk': None}
    config['modules'] = {}
    state = (repo / 'templates/workspace/Esprit/STATE.md').read_text()
    for key, value in {'AHORA':'2026-09-25 10:00', 'ZONA':'Europe/Madrid', 'FECHA':'2026-09-25', 'slug':'tesis', 'nombre':'Tesis', 'resumen':'Pendiente de definición', 'siguiente':'Preparar objetivos', 'carpeta':'Proyectos/Tesis'}.items():
        state = state.replace('{{'+key+'}}',value)
    (workspace/'Esprit/STATE.md').write_text(state)
    path = root/'config.json'
    env = dict(os.environ, ESPRIT_CONFIG=str(path))
    def check(expected):
        path.write_text(json.dumps(config))
        result = subprocess.run([str(binary),'--check-config'], env=env, capture_output=True, text=True)
        report=json.loads(result.stdout)
        assert report['ok'] is expected, (result.returncode, report)
        assert (result.returncode == 0) is expected
    check(True)
    subprocess.run([sys.executable,str(repo/'scripts/check_config.py'),str(path)],check=True,capture_output=True)
    config['modules']['notes']={'enabled':True}
    config['modules']['journal']={'enabled':True}
    check(True)
    assert not (workspace/'Esprit/quick-notes.json').exists()
    assert not (workspace/'Esprit/journal-club.json').exists()
    config['modules']['travel']={'enabled':True,'folder':'Viajes'}
    check(True)
    config['modules']['travel']['folder']='../privado'
    check(False)
    config['modules']={}
    config['projects'][0]['folder']='../privado'
    check(False)
    result=subprocess.run([str(binary),'--check-config'],env=dict(env,ESPRIT_CONFIG=str(root/'missing.json')),capture_output=True,text=True)
    assert result.returncode != 0 and json.loads(result.stdout)['ok'] is False
print('OK: módulos apagados, Viajes opcional, ruta rechazada y configuración ausente; sin fuentes externas.')
