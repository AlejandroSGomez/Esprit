"""Synthetic native bridge regression coverage. No network, login or real writes."""
import base64
import unittest
from unittest.mock import patch

from esprit_fixtures import load_bridge

mm = load_bridge('mattermost_bridge')
# 'admin' is a channel of the team that the user does not follow in Esprit.
CONFIG = {'identity': {'user_id': 'me', 'username': 'ana'}, 'team': {'id': 'team', 'name': 'test'}, 'channels': [{'id': 'research', 'name': 'research', 'type': 'O'}]}
def post(id='root', channel='research', **kw):
    return dict(id=id, channel_id=channel, root_id='', user_id='me', username='ana', created_local='2026-09-07', create_at=1, message='Original', delete_at=0, **kw)
class Client:
    base = 'https://example.test/api/v4'
    token = 'synthetic'
    def __init__(self): self.reads=[]; self.writes=[]; self.values={'/posts/root': post(), '/channels/research': {'id':'research','name':'research'}, '/channels/research/members/me': {'user_id':'me'}}
    def get(self, path):
        self.reads.append(path)
        return self.values[path]
    def _request(self, method, path, payload=None):
        self.writes.append((method,path,payload))
        return self.values.get(path, post()), {}
    def enrich_post(self, value): return value
class WorkspaceTests(unittest.TestCase):
    def test_category_order_filters_unknown_ids(self):
        client=Client();client.values['/users/me/teams/team/channels/categories']={'order':['second','first'], 'categories':[{'id':'first','display_name':'Channels','channel_ids':['research','outsider']},{'id':'second','display_name':'Projects','channel_ids':['admin']} ]}
        groups=mm.sidebar_categories(client,CONFIG)
        self.assertEqual([g['id'] for g in groups],['second','first'])
        self.assertEqual(groups[1]['channel_ids'],['research'])
    def test_followed_threads_filter_unfollowed_channels_before_enrichment(self):
        client=Client();client.values['/users/me/teams/team/threads?page=0&per_page=50&extended=false']={'threads':[{'post':post(), 'reply_count':3},{'post':post('protected',channel='admin')}]}
        with patch.object(client,'enrich_post',side_effect=AssertionError('No enrichment outside the allowlist')):
            result=mm.workspace_read(client,CONFIG,{'operation':'inbox','page':0})
        self.assertEqual([p['id'] for p in result['posts']],['root'])
        self.assertEqual(result['posts'][0]['reply_count'],3)
        self.assertIsNone(result['next_page'])
    def test_followed_threads_validate_page(self):
        with self.assertRaises(RuntimeError): mm.workspace_read(Client(),CONFIG,{'operation':'inbox','page':20})
    def test_missing_presence_is_not_offline(self):
        self.assertEqual(mm.read_statuses(Client(),['me']),{})
    def test_presence_projects_only_requested_ids_and_known_states(self):
        client=Client();client.values['/users/status/ids']=[{'user_id':'me','status':'away'},{'user_id':'outsider','status':'online'}]
        self.assertEqual(mm.read_statuses(client,['me']),{'me':'away'})
    def test_reactions_deduplicate_and_record_ownership(self):
        values=mm.normalized_reactions({'metadata':{'reactions':[{'user_id':'me','emoji_name':'+1'},{'user_id':'me','emoji_name':'+1'},{'user_id':'them','emoji_name':'+1'}]}},'me')
        self.assertEqual(values,[{'name':'+1','count':2,'own':True}])
    def test_thread_checks_channel_before_reading_thread(self):
        client=Client();client.values['/posts/root']=post(channel='other')
        with self.assertRaises(RuntimeError): mm.workspace_read(client,CONFIG,{'operation':'thread','channel_id':'research','post_id':'root'})
        self.assertFalse(any('/thread?' in p for p in client.reads))
    def test_thread_returns_only_this_thread(self):
        client=Client(); reply=post('reply');reply['root_id']='root'
        client.values['/posts/root/thread?perPage=100&direction=down']={'posts':{'root':post(),'reply':reply,'other':post('other',channel='admin')}}
        result=mm.workspace_read(client,CONFIG,{'operation':'thread','channel_id':'research','post_id':'root'})
        self.assertEqual([p['id'] for p in result['posts']],['reply','root'])
        self.assertIsNone(result['next_cursor'])
    def test_cursor_cannot_leave_thread(self):
        client=Client();client.values['/posts/other']=post('other')
        with self.assertRaises(RuntimeError):mm.workspace_read(client,CONFIG,{'operation':'thread','channel_id':'research','post_id':'root','cursor':'other'})
    def test_search_scope_is_native_and_results_filtered(self):
        client=Client();client.values['/teams/team/posts/search']={'posts':{'root':post(),'other':post('other',channel='admin')}}
        result=mm.workspace_read(client,CONFIG,{'operation':'search','channel_id':'research','query':'noise'})
        self.assertEqual(client.writes[0][2]['terms'],'in:research noise')
        self.assertEqual(len(result['posts']),1)
    def test_search_rejects_scope_injection_and_admin(self):
        for channel,query in [('research','in:admin noise'),('research','foo -in:research'),('admin','noise')]:
            client=Client()
            with self.assertRaises(RuntimeError):mm.workspace_read(client,CONFIG,{'operation':'search','channel_id':channel,'query':query})
            self.assertEqual(client.writes,[])
    def test_reactions_need_confirmation_and_live_target(self):
        client=Client();payload={'channel_id':'research','post_id':'root','emoji_name':'+1','remove':False,'confirmed':False}
        with self.assertRaises(RuntimeError):mm.react_message(client,CONFIG,payload)
        client.values['/posts/root']['delete_at']=2;payload['confirmed']=True
        with self.assertRaises(RuntimeError):mm.react_message(client,CONFIG,payload)
        self.assertEqual(client.writes,[])
    def test_reaction_removal_is_only_own(self):
        client=Client();client.values['/posts/root/reactions']=[]
        mm.react_message(client,CONFIG,{'channel_id':'research','post_id':'root','emoji_name':'heart','remove':True,'confirmed':True,'user_id':'other'})
        self.assertEqual(client.writes[0][:2],('DELETE','/users/me/posts/root/reactions/heart'))
    def test_upload_validation_precedes_all_network_writes(self):
        client=Client()
        for file in [{'name':'../secret','data_base64':'YQ=='},{'name':'a','data_base64':'!?'},{'name':'a','data_base64':''}]:
            with patch.object(mm,'urlopen') as upload:
                with self.assertRaises(RuntimeError):mm.send_with_files(client,CONFIG,{'channel_id':'research','message':'Test','files':[file],'confirmed':True})
                upload.assert_not_called()
        self.assertEqual(client.writes,[])
    def test_file_only_send_uploads_after_confirmation_and_binds_ids(self):
        client=Client();payload={'channel_id':'research','message':'','files':[{'name':'note.txt','data_base64':base64.b64encode(b'fixture').decode()}],'confirmed':False}
        with patch.object(mm,'urlopen') as upload:
            with self.assertRaises(RuntimeError):mm.send_with_files(client,CONFIG,payload)
            upload.assert_not_called()
            payload['confirmed']=True
            upload.return_value.__enter__.return_value.read.return_value=b'{"file_infos":[{"id":"fileone"}]}'
            mm.send_with_files(client,CONFIG,payload)
            self.assertEqual(upload.call_args.args[0].data,b'fixture')
            self.assertEqual(client.writes[-1][2]['file_ids'],['fileone'])
    def test_invalid_root_blocks_uploads(self):
        client=Client();payload={'channel_id':'research','root_id':'root','message':'a','files':[{'name':'x','data_base64':'YQ=='}],'confirmed':True};client.values['/posts/root']=post(channel='admin')
        with patch.object(mm,'urlopen') as upload:
            with self.assertRaises(RuntimeError):mm.send_with_files(client,CONFIG,payload)
            upload.assert_not_called()
    def test_uncertain_send_is_not_retried(self):
        client=Client()
        with patch.object(client,'_request',side_effect=TimeoutError) as request:
            with self.assertRaisesRegex(RuntimeError,'Comprueba el canal'):mm.send_with_files(client,CONFIG,{'channel_id':'research','message':'hello','files':[],'confirmed':True})
            self.assertEqual(request.call_count,1)
if __name__=='__main__': unittest.main()
