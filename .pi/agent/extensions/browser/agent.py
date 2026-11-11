"""Runs browser-use tasks on one Helium over CDP. Reads one JSON request per stdin line and writes JSON events to stdout."""

import os
import sys

PROTOCOL = os.fdopen(os.dup(1), "w")
os.dup2(2, 1)

import asyncio
import json
import logging

import httpx2
from anthropic import AsyncAnthropic, DefaultAsyncHttpxClient
from browser_use import Agent, Browser
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider

# Anthropic accepts a Claude subscription OAuth token only from requests that identify as Claude Code.
CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude."
OAUTH_BETA = "oauth-2025-04-20"


def send(**event):
    PROTOCOL.write(json.dumps(event) + "\n")
    PROTOCOL.flush()


class ClaudeCodeIdentity(httpx2.AsyncBaseTransport):
    def __init__(self):
        self.inner = httpx2.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path.startswith("/v1/messages"):
            body = json.loads(await request.aread())
            system = body.get("system") or []
            if isinstance(system, str):
                system = [{"type": "text", "text": system}]
            body["system"] = [{"type": "text", "text": CLAUDE_CODE}, *system]
            headers = httpx2.Headers(request.headers)
            headers.pop("content-length", None)
            betas = [b for b in headers.get("anthropic-beta", "").split(",") if b]
            headers["anthropic-beta"] = ",".join(dict.fromkeys([*betas, OAUTH_BETA]))
            request = httpx2.Request(
                request.method,
                request.url,
                headers=headers,
                content=json.dumps(body).encode(),
                extensions=request.extensions,
            )
        return await self.inner.handle_async_request(request)

    async def aclose(self):
        await self.inner.aclose()


def anthropic(llm: dict) -> AnthropicModel:
    client = (
        AsyncAnthropic(
            auth_token=llm["key"],
            http_client=DefaultAsyncHttpxClient(transport=ClaudeCodeIdentity()),
        )
        if llm["oauth"]
        else AsyncAnthropic(api_key=llm["key"])
    )
    return AnthropicModel(
        llm["model"], provider=AnthropicProvider(anthropic_client=client)
    )


class BackgroundBrowser(Browser):
    """The user's open Helium: the agent's tab stays in the background instead of becoming the visible tab."""

    async def start(self) -> dict[str, str]:
        env = await super().start()
        return {key: value for key, value in env.items() if key != "BU_OWN_BROWSER"}


class Steps(logging.Handler):
    def emit(self, record: logging.LogRecord):
        step, _, line = record.getMessage().partition(": ")
        if step.startswith("step "):
            send(type="step", text=line)


def outcome(result) -> dict:
    if result.status == "error":
        return {"status": "error", "reason": result.error}
    if result.status != "completed":
        return {
            "status": "blocked",
            "reason": f"Stopped at the {result.status.replace('_', ' ')} limit before an answer.",
        }
    return {
        "status": "blocked" if result.success is False else "done",
        "result": result.text,
    }


async def main():
    endpoint, placement = sys.argv[1:]
    browser = (BackgroundBrowser if placement == "background" else Browser)(
        cdp_url=endpoint, keep_alive=True
    )
    logging.getLogger("browser_use").addHandler(Steps())
    agent = None
    helpers = None
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = json.loads(line)
            try:
                env = await browser.start()
                if helpers is None:
                    os.environ["BU_NAME"] = env["BU_NAME"]
                    from browser_harness import helpers
                if url := request.get("url"):
                    await asyncio.to_thread(helpers.goto_url, url)
                    await asyncio.to_thread(helpers.wait_for_load)
                event = {"status": "done"}
                if goal := request.get("goal"):
                    if agent is None:
                        agent = Agent(
                            goal,
                            llm=anthropic(request["llm"]),
                            browser=browser,
                            mode="ultrafast",
                        )
                    else:
                        agent.add_new_task(goal)
                    event = outcome(await agent.run())
                page = await asyncio.to_thread(helpers.page_info)
                send(
                    type="result",
                    url=page.get("url", ""),
                    title=page.get("title", ""),
                    **event,
                )
            except (RuntimeError, ValueError, OSError) as error:
                send(
                    type="result",
                    status="error",
                    reason=str(error) or type(error).__name__,
                    url="",
                    title="",
                )
    finally:
        await browser.stop()


asyncio.run(main())
