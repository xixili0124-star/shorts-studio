"""실제 AI 호출 없이 동의·입력 제한·로컬 서버를 검사합니다."""
import importlib.util
import io
import json
import os
from pathlib import Path
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

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

    def request(self,path='/api/tts',body=None,headers=None,method=None):
        default={'Origin':self.base,'Content-Type':'application/json','X-Studio-Consent':'text-to-openai'}
        default.update(headers or {})
        payload=None if body is None else json.dumps(body).encode()
        req=Request(self.base+path,data=payload,headers=default,method=method)
        try:
            with urlopen(req,timeout=5) as response:
                return response.status,response.read(),response.headers
        except HTTPError as error:
            return error.code,error.read(),error.headers

    def test_static_editor_and_no_key_status(self):
        status,body,_=self.request('/studio.html')
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
            ('/js/studio-tools.js',b'export class StudioTools'),
            ('/js/silence.js',b'export function analyzeSilence'),
            ('/js/mosaic.js',b'export function mosaicAt'),
            ('/js/video-analysis.js',b'export async function trackMosaic'),
            ('/js/local-ai.js',b'export function runLocalAI'),
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

if __name__=='__main__':unittest.main()
