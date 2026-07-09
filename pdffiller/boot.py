# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe

from pdffiller.utils.ai_permissions import has_ai_access


def extend_bootinfo(bootinfo):
	bootinfo["pdffiller_ai_enabled"] = has_ai_access()
