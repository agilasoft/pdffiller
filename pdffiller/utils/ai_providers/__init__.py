# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe

from pdffiller.utils.ai_permissions import get_settings
from pdffiller.utils.ai_providers.anthropic_provider import AnthropicProvider
from pdffiller.utils.ai_providers.ollama_provider import OllamaProvider
from pdffiller.utils.ai_providers.openai_provider import OpenAIProvider


def get_provider():
	settings = get_settings()
	api_key = settings.get_password("api_key")
	provider = settings.provider
	model = settings.model

	if provider == "OpenAI":
		if not api_key:
			frappe.throw("OpenAI API key is not configured in PDF Filler AI Settings.")
		return OpenAIProvider(api_key=api_key, model=model)

	if provider == "Anthropic":
		if not api_key:
			frappe.throw("Anthropic API key is not configured in PDF Filler AI Settings.")
		return AnthropicProvider(api_key=api_key, model=model)

	if provider == "Azure OpenAI":
		if not api_key:
			frappe.throw("Azure OpenAI API key is not configured in PDF Filler AI Settings.")
		return OpenAIProvider(
			api_key=api_key,
			model=model,
			azure_endpoint=settings.azure_endpoint,
			azure_deployment=settings.azure_deployment,
		)

	if provider == "Ollama":
		return OllamaProvider(base_url=settings.ollama_base_url, model=model)

	frappe.throw(f"Unsupported provider: {provider}")
