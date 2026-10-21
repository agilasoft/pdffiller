# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from dataclasses import dataclass, field


@dataclass
class ProviderResponse:
	content: str | None = None
	token_usage: dict | None = None
