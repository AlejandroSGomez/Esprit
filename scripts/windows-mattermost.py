"""Ejecutar manualmente: el secreto nunca pasa por el chat ni por argumentos."""
import getpass,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src-tauri/resources'))
import windows_credentials
path=Path.home()/'.config/esprit/config.json'
config=json.loads(path.read_text(encoding='utf-8'))['modules']['mattermost']
secret=getpass.getpass('Token o contraseña de Mattermost (no se muestra): ')
windows_credentials.write(config['keychain_service'],config['username'],secret)
print('Credencial guardada en el Administrador de credenciales de Windows.')
