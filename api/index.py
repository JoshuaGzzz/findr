"""Vercel Python function: every /api/* request is rewritten here (see vercel.json).

The routes are the same ones backend/server.py serves locally; both come from backend/findr_api.py.
Items are read from Supabase with SUPABASE_URL + SUPABASE_KEY (publishable key) set in the Vercel project.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import findr_api  # noqa: E402


def load_items() -> list:
    return findr_api.supabase_source()()  # env is checked on every refresh, so a bad config becomes a JSON error


class handler(findr_api.ApiHandler):
    index = findr_api.Index(load_items)  # one per warm instance; a cold start loads on its first request
