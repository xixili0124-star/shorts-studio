"""실제 AI 호출 없이 동의·입력 제한·로컬 서버를 검사합니다."""
import importlib.util
import base64
import io
import json
import os
from pathlib import Path
import threading
import tempfile
import subprocess
import sys
import unittest
import wave
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from pc_voice import VoiceCloneService, VoiceError, wav_info, MAX_REFERENCE_BODY, local_engine_key, engine_proof

spec=importlib.util.spec_from_file_location('studio_server',Path(__file__).resolve().parents[1]/'studio_server.py')
studio=importlib.util.module_from_spec(spec)
spec.loader.exec_module(studio)

class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=studio.ThreadingHTTPServer(('127.0.0.1',0),studio.StudioHandler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.env=patch.dict(os.environ,{'OPENAI_API_KEY':''})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.upstream=patch.object(studio,'urlopen')
        self.call=self.upstream.start()
        self.addCleanup(self.upstream.stop)
        studio.REQUEST_TIMES.clear()
        temporary=tempfile.TemporaryDirectory(prefix='studio-voice-test-')
        self.addCleanup(temporary.cleanup)
        self.pc=VoiceCloneService(Path(temporary.name)/'private-voices')
        self.server.pc_voice=self.pc
        self.pc_mock=patch.object(self.pc.opener,'open')
        self.pc_call=self.pc_mock.start()
        self.addCleanup(self.pc_mock.stop)
        # Isolate storage/locking/output tests; identity is covered separately
        # and is not mocked in the real loopback transport test below.
        self.engine_auth=patch.object(self.pc,'require_engine')
        self.engine_auth.start()
        self.addCleanup(self.engine_auth.stop)

    def request(self,path='/api/tts',body=None,headers=None,method=None):
        default={'Origin':self.base,'Content-Type':'application/json','X-Studio-Consent':'text-to-openai'}
        default.update(headers or {})
        default={key:value for key,value in default.items() if value is not None}
        payload=None if body is None else json.dumps(body).encode()
        req=Request(self.base+path,data=payload,headers=default,method=method)
        try:
            with urlopen(req,timeout=5) as response:
                return response.status,response.read(),response.headers
        except HTTPError as error:
            return error.code,error.read(),error.headers

    def pc_request(self,path='status',body=None,headers=None):
        return self.request('/api/voice-clone/'+path,body,
                            {'X-Studio-PC-Voice':'1','X-Studio-Consent':'voice-clone-local',**(headers or {})})

    def private_engine_health(self):
        key='private_test_key_'+'a'*32
        self.pc.engine_headers={'X-Studio-Engine-Key':key}
        def read(maximum):
            request=self.pc_call.call_args.args[0]
            return json.dumps({'service':'shorts-studio-pc-voice','protocol':1,
                'proof':engine_proof(key,request.get_header('X-studio-engine-nonce'))}).encode()
        self.pc_call.return_value.__enter__.return_value.read.side_effect=read
        return key

    @staticmethod
    def pcm_wave(duration=3.25,rate=32000,silent=False):
        stream=io.BytesIO()
        with wave.open(stream,'wb') as audio:
            audio.setparams((1,2,rate,0,'NONE','not compressed'))
            audio.writeframes((b'\0\0' if silent else b'\xe8\x03')*int(duration*rate))
        return stream.getvalue()

    def new_reference(self):
        data={'name':'내 목소리','promptText':'안녕하세요. 참고 음성입니다.','consent':True,
              'audio':base64.b64encode(self.pcm_wave()).decode()}
        return self.pc.register(data)

    def test_static_editor_and_no_key_status(self):
        status,body,_=self.request('/studio.html')
        self.assertEqual(self.request('/pc-voice-setup.html')[0],200)
        self.assertEqual(status,200)
        self.assertIn(b'js/studio-app.js',body)
        self.assertIn(b'id="rippleDeleteClip"',body)
        status,body,_=self.request('/js/timeline-edits.js')
        self.assertEqual(status,200)
        self.assertIn(b'export function planVideoPlacement',body)
        for path,marker in (
            ('/js/font-catalog.js',b'export const FONTS'),
            ('/js/safe-areas.js',b'export const SAFE_AREAS'),
            ('/js/sound-effects.js',b'export const SOUND_EFFECTS'),
            ('/js/visual-transform.js',b'export function transformOf'),
            ('/js/batch-edits.js',b'export function planBatchSplit'),
            ('/js/monitor-editor.js',b'export class MonitorEditor'),
            ('/js/studio-tools.js',b'export class StudioTools'),
            ('/js/silence.js',b'export function analyzeSilence'),
            ('/js/mosaic.js',b'export function mosaicAt'),
            ('/js/video-analysis.js',b'export async function trackMosaic'),
            ('/js/local-ai.js',b'export function runLocalAI'),
            ('/js/pc-voice.js',b'export function isPcVoiceOrigin'),
            ('/js/tts-worker.js',b'TextToSpeech'),
            ('/js/asr-worker.js',b'automatic-speech-recognition'),
        ):
            with self.subTest(module=path):
                status,body,_=self.request(path)
                self.assertEqual(status,200)
                self.assertIn(marker,body)
        for path,mime in (
            ('/vendor/onnxruntime-web/1.23.2/ort.wasm.min.mjs','text/javascript'),
            ('/vendor/onnxruntime-web/1.23.2/ort-wasm-simd-threaded.wasm','application/wasm'),
            ('/vendor/transformers/3.8.1/ort-wasm-simd-threaded.jsep.mjs','text/javascript'),
            ('/vendor/transformers/3.8.1/ort-wasm-simd-threaded.jsep.wasm','application/wasm'),
        ):
            with self.subTest(runtime=path):
                status,_,headers=self.request(path,method='HEAD')
                self.assertEqual(status,200)
                self.assertEqual(headers.get_content_type(),mime)
                self.assertGreater(int(headers['Content-Length']),1000)
        status,body,_=self.request('/api/ai/status')
        self.assertFalse(json.loads(body)['configured'])
        self.assertFalse(json.loads(body)['verified'])
        self.call.assert_not_called()

    def test_missing_key_fails_without_network(self):
        status,body,_=self.request(body={'text':'테스트','voice':'marin'})
        self.assertEqual(status,503)
        self.assertEqual(json.loads(body)['error']['code'],'AI_NOT_CONFIGURED')
        self.call.assert_not_called()

    def test_external_origin_and_missing_consent_are_rejected(self):
        for headers in ({'Origin':'https://example.org'},{'X-Studio-Consent':''},{'Host':'evil.test'}):
            with self.subTest(headers=headers):
                status,_,_=self.request(body={'text':'hello'},headers=headers)
                self.assertEqual(status,403)
        self.call.assert_not_called()

    def test_validation_rejects_unsupported_voice_speed_and_large_text(self):
        for data in ({'text':''},{'text':'x'*2001},{'text':'x','voice':'fake'},{'text':'x','speed':True},{'text':'x','speed':float('nan')},{'text':'x','speed':5}):
            with self.subTest(data_type=list(data)):
                with self.assertRaises(ValueError):studio.validate_tts(data)
        result=studio.validate_tts({'text':'한국어','voice':'cedar','speed':1.1})
        self.assertEqual(result['model'],'gpt-4o-mini-tts')
        self.assertEqual(result['response_format'],'wav')

    def test_content_type_and_size_limits(self):
        status,_,_=self.request(body={'text':'hello'},headers={'Content-Type':'text/plain'})
        self.assertEqual(status,415)
        status,_,_=self.request(body={'text':'x'*70000})
        self.assertEqual(status,413)
        self.call.assert_not_called()

    def test_mock_speech_success_never_exposes_key(self):
        # 가짜 토큰과 가짜 upstream 응답만 사용합니다.
        wave=b'RIFF'+b'\x24\x00\x00\x00'+b'WAVE'+bytes(32)
        self.call.return_value.__enter__.return_value.read.return_value=wave
        with patch.dict(os.environ,{'OPENAI_API_KEY':'test-placeholder-only'}):
            status,body,headers=self.request(body={'text':'hello','voice':'marin'})
            self.assertEqual(status,200)
            self.assertEqual(body,wave)
            self.assertEqual(headers['Content-Type'],'audio/wav')
            _,state,_=self.request('/api/ai/status')
            self.assertNotIn(b'test-placeholder-only',state)
        request=self.call.call_args.args[0]
        self.assertEqual(request.full_url,'https://api.openai.com/v1/audio/speech')

    def test_timestamp_multipart_uses_word_and_segment(self):
        body,content_type=studio.transcription_body(b'wave-bytes')
        self.assertIn(b'whisper-1',body)
        self.assertIn(b'verbose_json',body)
        self.assertEqual(body.count(b'name="timestamp_granularities[]"'),2)
        self.assertIn(b'wave-bytes',body)
        self.assertTrue(content_type.startswith('multipart/form-data; boundary=studio-'))

    def test_pc_status_checks_api_without_claiming_inference_and_hides_paths(self):
        profile=self.new_reference()
        self.private_engine_health()
        status,body,_=self.pc_request()
        self.assertEqual(status,200)
        data=json.loads(body)
        self.assertEqual(data['state'],'ready')
        self.assertFalse(data['inferenceVerified'])
        self.assertEqual(data['profiles'][0]['id'],profile['id'])
        self.assertNotIn(str(self.pc.directory).encode(),body)
        self.assertNotIn(b'ref_audio_path',body)
        self.assertEqual(self.pc_call.call_args.args[0].full_url,'http://127.0.0.1:9880/studio/health')
        self.call.assert_not_called()

    def test_pc_register_delete_and_static_server_never_serves_reference(self):
        data={'name':'내 목소리','promptText':'읽은 문장','consent':True,
              'audio':base64.b64encode(self.pcm_wave()).decode()}
        status,body,_=self.pc_request('references',data)
        self.assertEqual(status,201)
        profile=json.loads(body)['profile']
        self.assertEqual(profile['duration'],3.25)
        self.assertTrue((self.pc.directory/(profile['id']+'.wav')).exists())
        self.assertEqual(self.request('/.studio-local/voices/'+profile['id']+'.wav')[0],404)
        status,_,_=self.pc_request('delete',{'profileId':profile['id'],'consent':True})
        self.assertEqual(status,200)
        self.assertEqual(list(self.pc.directory.iterdir()),[])
        self.pc_call.assert_not_called()
        self.call.assert_not_called()

    def test_pc_requests_reject_cross_origin_missing_headers_and_consent(self):
        for route in ('references','delete','synthesize'):
            for headers in ({'Origin':'https://evil.test'},{'Origin':'null'},{'Origin':None},
                            {'Host':'evil.test'},{'X-Studio-PC-Voice':None},{'X-Studio-Consent':None},
                            {'Sec-Fetch-Site':'cross-site'}):
                with self.subTest(route=route,headers=headers):
                    self.assertEqual(self.pc_request(route,{'consent':True},headers)[0],403)
        self.assertEqual(self.pc_request(headers={'Origin':'https://evil.test'})[0],403)
        self.assertEqual(self.pc_request(headers={'X-Studio-PC-Voice':None})[0],403)
        self.pc_call.assert_not_called()
        self.assertFalse(self.pc.directory.exists())

    def test_pc_partial_delete_keeps_reference_visible_and_retryable(self):
        original_unlink=Path.unlink
        for blocked_suffix in ('.wav','.json'):
            with self.subTest(blocked_suffix=blocked_suffix):
                profile=self.new_reference()
                def locked(path,*args,**kwargs):
                    if path.stem==profile['id'] and path.suffix==blocked_suffix:raise PermissionError('test file lock')
                    return original_unlink(path,*args,**kwargs)
                with patch.object(Path,'unlink',locked):
                    with self.assertRaises(VoiceError):self.pc.delete(profile['id'])
                listed=self.pc.profiles()
                self.assertEqual(len(listed),1)
                self.assertEqual(listed[0]['audioAvailable'],blocked_suffix=='.wav')
                self.pc.delete(profile['id'])
                self.assertEqual(list(self.pc.directory.iterdir()),[])

    def test_pc_bad_unicode_is_rejected_before_private_files_are_written(self):
        for key in ('name','promptText'):
            data={'name':'valid','promptText':'valid','consent':True,'audio':base64.b64encode(self.pcm_wave()).decode()}
            data[key]='\ud800'
            with self.assertRaises(VoiceError) as caught:self.pc.register(data)
            self.assertEqual(caught.exception.code,'INVALID_REFERENCE_TEXT')
            self.assertEqual(list(self.pc.directory.glob('*')),[])

    def test_pc_engine_key_is_sent_only_in_private_upstream_headers(self):
        key=self.private_engine_health()
        status=self.pc.status()
        self.assertNotIn(key,json.dumps(status))
        self.assertIsNone(self.pc_call.call_args.args[0].get_header('X-studio-engine-key'))
        profile=self.new_reference()
        self.pc_call.return_value.__enter__.return_value.read.side_effect=None
        self.pc_call.return_value.__enter__.return_value.read.return_value=self.pcm_wave(1)
        self.pc.synthesize({'profileId':profile['id'],'text':'test','consent':True})
        request=self.pc_call.call_args.args[0]
        self.assertEqual(request.get_header('X-studio-engine-key'),key)
        self.assertNotIn(key,request.data.decode())
        settings=self.pc.directory/'settings.json'
        settings.write_text(json.dumps({'engineKey':key}),encoding='utf-8')
        self.assertEqual(local_engine_key(settings),key)
        settings.write_text('{"engineKey":"bad\\nheader"}',encoding='utf-8')
        self.assertIsNone(local_engine_key(settings))

    def test_pc_status_rejects_raw_engines_and_forged_or_replayed_health(self):
        self.private_engine_health()
        self.assertEqual(self.pc.status()['state'],'ready')
        read=self.pc_call.return_value.__enter__.return_value.read
        recorded=read.side_effect(4097)
        read.side_effect=None
        for result in (b'{"paths":{"/tts":{"post":{}}}}',
                       b'{"service":"shorts-studio-pc-voice","protocol":1,"proof":"fake"}',recorded):
            read.return_value=result
            self.assertEqual(self.pc.status()['state'],'offline')

    def test_pc_generation_rechecks_identity_without_sending_key_or_voice_to_another_server(self):
        self.engine_auth.stop()
        self.private_engine_health()
        self.assertEqual(self.pc.status()['state'],'ready')
        profile=self.new_reference()
        self.pc_call.reset_mock()
        self.pc_call.return_value.__enter__.return_value.read.side_effect=None
        self.pc_call.return_value.__enter__.return_value.read.return_value=b'{"paths":{"/tts":{"post":{}}}}'
        with self.assertRaises(VoiceError) as caught:self.pc.synthesize({'profileId':profile['id'],'text':'PRIVATE SCRIPT','consent':True})
        self.assertEqual(caught.exception.code,'ENGINE_NOT_READY')
        self.assertEqual(self.pc_call.call_count,1)
        request=self.pc_call.call_args.args[0]
        self.assertEqual(request.get_method(),'GET')
        self.assertTrue(request.full_url.endswith('/studio/health'))
        self.assertIsNone(request.get_header('X-studio-engine-key'))
        self.assertIsNone(request.data)

    def test_pc_installer_does_not_publish_settings_before_resources_succeed(self):
        import setup_pc_voice as setup
        previous=self.pc.directory.parent/'old-settings.json'
        previous.write_text('existing working installation',encoding='utf-8')
        engine=self.pc.directory.parent/'new-engine'
        def install(command,**kwargs):
            if any(str(part).endswith('prepare_pc_voice_resources.py') for part in command):
                raise subprocess.CalledProcessError(1,command)
        with patch.object(sys,'argv',['setup_pc_voice.py','--yes','--engine-dir',str(engine)]), \
             patch.object(setup,'prepare_source',return_value=engine/'source'), \
             patch.object(setup,'prepare_models'), patch.object(setup,'prepare_uv',return_value=engine/'uv.exe'), \
             patch.object(setup.subprocess,'check_output',return_value=sys.executable), \
             patch.object(setup.subprocess,'run',side_effect=install), patch.object(setup,'write_config') as publish:
            with self.assertRaises(subprocess.CalledProcessError):setup.main()
            publish.assert_not_called()
        self.assertEqual(previous.read_text(),'existing working installation')

    def test_pc_engine_process_blocks_external_resolution_and_allows_loopback(self):
        code="""
import socket
from pc_voice_engine import restrict_engine_network
restrict_engine_network()
for operation in (lambda: socket.getaddrinfo('example.invalid',443), lambda: socket.gethostbyname('example.invalid')):
    try: operation()
    except OSError: pass
    else: raise AssertionError('External resolution was allowed')
with socket.socket() as server:
    try: server.bind(('0.0.0.0',0))
    except OSError: pass
    else: raise AssertionError('Public bind was allowed')
    server.bind(('127.0.0.1',0)); server.listen(1)
    with socket.create_connection(server.getsockname(),timeout=2) as client:
        peer,_=server.accept()
        with peer:
            client.sendall(b'local'); assert peer.recv(5)==b'local'
"""
        result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)

    @unittest.skipUnless(os.name=='nt','Windows process job lifecycle')
    def test_pc_launcher_exit_reaps_its_children_without_targeting_other_processes(self):
        code="""
import os, subprocess, sys
from start_pc_voice import own_windows_process_tree
job=own_windows_process_tree()
grandchild_code="import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(10)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW); print(child.pid,flush=True); time.sleep(10)"
child=subprocess.Popen([sys.executable,'-c',grandchild_code],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
grandchild_pid=child.stdout.readline().strip()
print(child.pid,grandchild_pid,flush=True)
os._exit(0)
"""
        result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        import ctypes
        from ctypes import wintypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.WaitForSingleObject.restype=wintypes.DWORD
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        children=[int(value) for value in result.stdout.split()]
        self.assertEqual(len(children),2)
        for child in children:
            handle=kernel.OpenProcess(0x00100000,False,child)
            if handle:
                try:self.assertEqual(kernel.WaitForSingleObject(handle,3000),0,'Owned descendant survived launcher exit')
                finally:kernel.CloseHandle(handle)
            else:self.assertEqual(ctypes.get_last_error(),87,'Could not verify owned descendant termination')

    def test_pc_reference_rejects_bad_wav_silence_duration_and_truncation(self):
        valid=self.pcm_wave()
        for content in (b'not audio',valid[:-2],self.pcm_wave(2.99),self.pcm_wave(10.01),self.pcm_wave(silent=True)):
            with self.subTest(length=len(content)):
                with self.assertRaises(VoiceError):wav_info(content,reference=True)
        self.assertEqual(wav_info(self.pcm_wave(3),reference=True)['duration'],3)
        self.assertEqual(wav_info(self.pcm_wave(10),reference=True)['duration'],10)
        for data in ({'consent':False},{'consent':True,'name':'x','promptText':'x','audio':'!!!'},
                     {'consent':True,'name':'x','promptText':'','audio':base64.b64encode(valid).decode()}):
            with self.assertRaises(VoiceError):self.pc.register(data)
        self.assertEqual(self.pc_request('references',{'audio':'x'*MAX_REFERENCE_BODY})[0],413)
        self.assertEqual(self.pc_request('references',{},headers={'Content-Type':'text/plain'})[0],415)
        self.assertFalse(self.pc.directory.exists())

    def test_pc_synthesis_uses_owned_path_and_actual_wave_metadata(self):
        profile=self.new_reference();result=self.pcm_wave(1.5,48000)
        self.pc_call.return_value.__enter__.return_value.read.return_value=result
        status,body,headers=self.pc_request('synthesize',{'profileId':profile['id'],'text':'새로운 원고','speed':1.1,
                              'ref_audio_path':'C:/private.txt','endpoint':'https://evil.test','consent':True})
        self.assertEqual(status,200)
        self.assertEqual(body,result)
        self.assertEqual(headers['X-Studio-Audio-Rate'],'48000')
        self.assertEqual(float(headers['X-Studio-Audio-Duration']),1.5)
        request=self.pc_call.call_args.args[0];data=json.loads(request.data)
        self.assertEqual(request.full_url,'http://127.0.0.1:9880/tts')
        self.assertEqual(data['text_lang'],'ko')
        self.assertEqual(data['prompt_text'],profile['promptText'])
        self.assertEqual(Path(data['ref_audio_path']),self.pc.directory/(profile['id']+'.wav'))
        self.assertFalse(data['streaming_mode'])
        self.assertNotIn('endpoint',data)
        self.call.assert_not_called()

    def test_pc_validation_rejects_arbitrary_profile_paths_and_nonfinite_speed(self):
        profile=self.new_reference()
        for profile_id in ('../outside','/tmp/file','C:\\private','a'*31,'a'*33,None):
            with self.subTest(profile_id=profile_id):
                with self.assertRaises(VoiceError):self.pc.delete(profile_id)
        for changes in ({'text':''},{'text':'x'*2001},{'speed':True},{'speed':float('nan')},{'speed':float('inf')},
                        {'speed':0},{'profileId':'../outside'},{'consent':False}):
            with self.subTest(changes=list(changes)):
                with self.assertRaises(VoiceError):self.pc.synthesize({'profileId':profile['id'],'text':'원고','consent':True,**changes})
        self.pc_call.assert_not_called()

    def test_pc_model_work_keeps_lock_until_response_finishes(self):
        profile=self.new_reference();entered=threading.Event();release=threading.Event();errors=[]
        def read(maximum):
            entered.set()
            if not release.wait(4):raise TimeoutError()
            return self.pcm_wave(1)
        self.pc_call.return_value.__enter__.return_value.read.side_effect=read
        def generate():
            try:self.pc.synthesize({'profileId':profile['id'],'text':'원고','consent':True})
            except Exception as error:errors.append(error)
        thread=threading.Thread(target=generate);thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.pc.status()['state'],'busy')
            for operation in (lambda:self.pc.delete(profile['id']),lambda:self.pc.synthesize({'profileId':profile['id'],'text':'새 원고','consent':True})):
                with self.assertRaises(VoiceError) as caught:operation()
                self.assertEqual(caught.exception.code,'VOICE_BUSY')
            self.assertEqual(self.pc_call.call_count,1)
        finally:release.set();thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[])
        self.pc.delete(profile['id'])

    def test_pc_uncertain_timeout_blocks_retry_and_invalid_audio_is_not_returned(self):
        profile=self.new_reference();payload={'profileId':profile['id'],'text':'원고','consent':True}
        self.pc_call.return_value.__enter__.return_value.read.return_value=b'not a wav'
        self.assertEqual(self.pc_request('synthesize',payload)[0],502)
        self.pc_call.side_effect=TimeoutError()
        status,body,_=self.pc_request('synthesize',payload)
        self.assertEqual(status,503)
        self.assertEqual(json.loads(body)['error']['code'],'ENGINE_RESTART_REQUIRED')
        self.pc_call.reset_mock()
        self.assertEqual(self.pc.status()['state'],'restart-required')
        self.assertEqual(self.pc_request('synthesize',payload)[0],503)
        self.pc_call.assert_not_called()

    def test_pc_http_errors_do_not_expose_internal_paths_or_prompt(self):
        profile=self.new_reference()
        self.pc_call.side_effect=HTTPError('http://127.0.0.1:9880/tts',500,'C:/private/secret prompt',{},io.BytesIO(b'secret model path'))
        status,body,_=self.pc_request('synthesize',{'profileId':profile['id'],'text':'원고','consent':True})
        self.assertEqual(status,502)
        self.assertNotIn(b'secret',body)
        self.assertNotIn(b'C:/',body)
        self.assertNotIn(str(self.pc.directory).encode(),body)

    def test_pc_opener_ignores_proxy_and_does_not_follow_redirects(self):
        seen=[];redirect=[False];audio=self.pcm_wave(1);key='isolated_test_engine_'+'x'*32
        class Upstream(studio.SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(inner):
                seen.append((inner.path,inner.headers.get('X-Studio-Engine-Key')))
                proof=engine_proof(key,inner.headers['X-Studio-Engine-Nonce'])
                body=json.dumps({'service':'shorts-studio-pc-voice','protocol':1,'proof':proof}).encode()
                inner.send_response(200);inner.send_header('Content-Type','application/json');inner.end_headers();inner.wfile.write(body)
            def do_POST(inner):
                seen.append((inner.path,inner.headers.get('X-Studio-Engine-Key')));inner.rfile.read(int(inner.headers.get('Content-Length','0')))
                if redirect[0]:
                    inner.send_response(307);inner.send_header('Location','http://127.0.0.1:'+str(inner.server.server_port)+'/leak');inner.end_headers()
                else:
                    inner.send_response(200);inner.send_header('Content-Type','audio/wav');inner.end_headers();inner.wfile.write(audio)
        upstream=studio.ThreadingHTTPServer(('127.0.0.1',0),Upstream)
        worker=threading.Thread(target=upstream.serve_forever,daemon=True);worker.start()
        try:
            service=VoiceCloneService(self.pc.directory,port=upstream.server_port,engine_key=key)
            profile=self.new_reference();payload={'profileId':profile['id'],'text':'원고','consent':True}
            with patch.dict(os.environ,{'HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1','NO_PROXY':''}):
                result,_=service.synthesize(payload)
            self.assertEqual(result,audio)
            redirect[0]=True
            with self.assertRaises(VoiceError):service.synthesize(payload)
            self.assertEqual(seen,[('/studio/health',None),('/tts',key),('/studio/health',None),('/tts',key)])
        finally:upstream.shutdown();upstream.server_close();worker.join()

if __name__=='__main__':unittest.main()
