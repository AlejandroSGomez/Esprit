"""Windows Credential Manager storage for optional Mattermost (standard library)."""
import ctypes
from ctypes import wintypes
import os

class Credential(ctypes.Structure):
    _fields_=[('Flags',wintypes.DWORD),('Type',wintypes.DWORD),('TargetName',wintypes.LPWSTR),('Comment',wintypes.LPWSTR),('LastWritten',wintypes.FILETIME),('CredentialBlobSize',wintypes.DWORD),('CredentialBlob',ctypes.POINTER(ctypes.c_ubyte)),('Persist',wintypes.DWORD),('AttributeCount',wintypes.DWORD),('Attributes',ctypes.c_void_p),('TargetAlias',wintypes.LPWSTR),('UserName',wintypes.LPWSTR)]

def target(service,account):return 'Esprit/'+service+'/'+account

def api():
    if os.name!='nt':raise RuntimeError('Solo disponible en Windows')
    dll=ctypes.WinDLL('Advapi32.dll',use_last_error=True)
    dll.CredReadW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.POINTER(ctypes.POINTER(Credential))];dll.CredReadW.restype=wintypes.BOOL
    dll.CredWriteW.argtypes=[ctypes.POINTER(Credential),wintypes.DWORD];dll.CredWriteW.restype=wintypes.BOOL
    dll.CredFree.argtypes=[ctypes.c_void_p];dll.CredFree.restype=None
    return dll

def read(service,account):
    dll=api();ptr=ctypes.POINTER(Credential)()
    if not dll.CredReadW(target(service,account),1,0,ctypes.byref(ptr)):raise RuntimeError('Falta la credencial de Mattermost. Ejecuta scripts/windows-mattermost.py en tu Terminal.')
    try:return ctypes.string_at(ptr.contents.CredentialBlob,ptr.contents.CredentialBlobSize).decode('utf-16-le')
    finally:dll.CredFree(ptr)

def write(service,account,secret):
    dll=api();data=secret.encode('utf-16-le')
    if not data or len(data)>2560:raise ValueError('Secreto vacío o demasiado largo')
    buf=(ctypes.c_ubyte*len(data)).from_buffer_copy(data)
    cred=Credential(Type=1,TargetName=target(service,account),CredentialBlobSize=len(data),CredentialBlob=buf,Persist=2,UserName=account)
    if not dll.CredWriteW(ctypes.byref(cred),0):raise RuntimeError('Windows no pudo guardar la credencial')
