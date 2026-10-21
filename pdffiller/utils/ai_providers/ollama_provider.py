# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import requests

from pdffiller.utils.ai_providers.base import ProviderResponse


class OllamaProvider:
	def __init__(self, base_url, model):
		self.base_url = (base_url or "http://localhost:11434").rstrip("/")
		self.model = model

	def chat(self, messages):
		payload = {
			"model": self.model,
			"messages": messages,
			"stream": False,
		}

		resp = requests.post(f"{self.base_url}/api/chat", json=payload, timeout=120)
		resp.raise_for_status()
		data = resp.json()
		message = data.get("message") or {}

		return ProviderResponse(
			content=message.get("content"),
			token_usage=data.get("eval_count"),
		)
