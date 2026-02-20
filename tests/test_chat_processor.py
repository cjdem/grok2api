import asyncio

import pytest

from app.core.exceptions import UpstreamException
from app.services.grok.processor import CollectProcessor, StreamProcessor


async def _agen(lines):
    for line in lines:
        yield line


def test_collect_fallback_tokens_when_no_model_response():
    async def _run():
        proc = CollectProcessor("grok-3", token="")
        resp = _agen(
            [
                b'{"result":{"response":{"token":"h"}}}\n',
                b'{"result":{"response":{"token":"i"}}}\n',
            ]
        )
        return await proc.process(resp)

    out = asyncio.run(_run())
    assert out["choices"][0]["message"]["content"] == "hi"


def test_stream_emits_model_response_message_when_no_tokens():
    async def _run():
        proc = StreamProcessor("grok-3", token="", think=False)
        resp = _agen([b'{"result":{"response":{"modelResponse":{"message":"hello"}}}}\n'])
        chunks = []
        async for chunk in proc.process(resp):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(_run())
    assert any("hello" in c for c in chunks)


def test_stream_outputs_hint_when_upstream_empty():
    async def _run():
        proc = StreamProcessor("grok-3", token="", think=False)
        resp = _agen([])
        chunks = []
        async for chunk in proc.process(resp):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(_run())
    assert any("上游未返回可用内容" in c for c in chunks)


def test_collect_raises_on_upstream_error_frame():
    async def _run():
        proc = CollectProcessor("grok-3", token="")
        resp = _agen([b'{"error":{"message":"bad"}}\n'])
        await proc.process(resp)

    with pytest.raises(UpstreamException):
        asyncio.run(_run())


def test_collect_raises_when_upstream_empty():
    async def _run():
        proc = CollectProcessor("grok-3", token="")
        resp = _agen([])
        await proc.process(resp)

    with pytest.raises(UpstreamException):
        asyncio.run(_run())

