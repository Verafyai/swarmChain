"""Build chain.verafy.ai/constitution from CONSTITUTION.md.

    python3 site/build.py        (needs: pip install markdown)

index.html is hand-written; this renders site/constitution.html and site/amendments.html.
Commit the output: Vercel serves site/ as static files with no build step.
"""
import html as H
import pathlib

import markdown

SITE = pathlib.Path(__file__).resolve().parent
REPO = SITE.parent
HOST = 'https://chain.verafy.ai'
HARNESS = 'https://harness.verafy.ai'

MARK = '<svg class="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><line x1="16" y1="16" x2="16.00" y2="5.00" stroke="currentColor" stroke-width="1.2" opacity=".45"/><line x1="16" y1="16" x2="26.46" y2="12.60" stroke="currentColor" stroke-width="1.2" opacity=".45"/><line x1="16" y1="16" x2="22.47" y2="24.90" stroke="currentColor" stroke-width="1.2" opacity=".45"/><line x1="16" y1="16" x2="9.53" y2="24.90" stroke="currentColor" stroke-width="1.2" opacity=".45"/><line x1="16" y1="16" x2="5.54" y2="12.60" stroke="currentColor" stroke-width="1.2" opacity=".45"/><circle cx="16" cy="16" r="5.2" fill="var(--accent)"/><rect x="12.80" y="1.80" width="6.4" height="6.4" rx="1" fill="var(--sheet)" stroke="currentColor" stroke-width="1.6"/><rect x="23.26" y="9.40" width="6.4" height="6.4" rx="1" fill="var(--sheet)" stroke="currentColor" stroke-width="1.6"/><rect x="19.27" y="21.70" width="6.4" height="6.4" rx="1" fill="var(--sheet)" stroke="currentColor" stroke-width="1.6"/><rect x="6.33" y="21.70" width="6.4" height="6.4" rx="1" fill="var(--sheet)" stroke="currentColor" stroke-width="1.6"/><rect x="2.34" y="9.40" width="6.4" height="6.4" rx="1" fill="var(--sheet)" stroke="currentColor" stroke-width="1.6"/></svg>'

TABS = [
    ('/', 'Verafy Chain'),
    ('/constitution', 'Constitution'),
    (HARNESS, 'Verafy Harness'),
    (HARNESS + '/run', 'Run a harness'),
    (HARNESS + '/testnet', 'Testnet'),
    (HARNESS + '/coin-agnostic', 'Coin Agnostic'),
    ('https://asc.verafy.ai', 'Actually Smart Contracts'),
    ('https://github.com/Verafyai/verafyHarness', 'GitHub'),
    ('/#roadmap', 'Roadmap'),
]

CSS = r'''
:root{--paper:#EDF0F3;--sheet:#FFFFFF;--ink:#16212C;--mute:#566473;--rule:#CDD5DD;--accent:#3640C9;--accent-soft:#DADDF7;--allow:#1C7A4E;--hold:#A0561A;--code:#F4F6F8;
--display:"Archivo","Helvetica Neue",Arial,sans-serif;--body:"Source Serif 4",Georgia,serif;--mono:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--paper:#0F151B;--sheet:#161E26;--ink:#E4EAF0;--mute:#93A1AF;--rule:#2A3541;--accent:#8A92FF;--accent-soft:#252A55;--allow:#5CC995;--hold:#E0A060;--code:#1B242E;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#0F151B;--sheet:#161E26;--ink:#E4EAF0;--mute:#93A1AF;--rule:#2A3541;--accent:#8A92FF;--accent-soft:#252A55;--allow:#5CC995;--hold:#E0A060;--code:#1B242E;color-scheme:dark}
*{box-sizing:border-box}body{background:var(--paper);color:var(--ink);font-family:var(--body);font-size:17.5px;line-height:1.6;margin:0}
a{color:var(--accent);text-underline-offset:3px}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
img{max-width:100%;height:auto}
.wrap{max-width:1240px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.coinfree{background:var(--sheet);border-top:3px solid var(--accent);border-bottom:1px solid var(--rule)}
.coinfree .wrap{padding-block:18px 20px;display:flex;flex-direction:column;gap:6px}
.coinfree h2{font-family:var(--display);font-weight:750;font-size:clamp(22px,2.4vw,28px);margin:0}
.coinfree p{max-width:46em;margin:0;overflow-wrap:break-word}
.top{display:flex;align-items:center;gap:16px;padding-block:20px;border-bottom:1px solid var(--rule);flex-wrap:wrap}
.brand{font-family:var(--display);font-weight:800;font-size:20px;font-stretch:110%;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;gap:10px}
.brand .mark{color:var(--ink);flex:none}
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin-right:auto;margin-left:12px}
.tabs a{font-family:var(--display);font-weight:600;font-size:15px;color:var(--mute);text-decoration:none;padding:6px 10px;border-radius:2px;border:1px solid transparent}
.tabs a:hover{color:var(--ink);border-color:var(--rule)}.tabs a[aria-current="page"]{color:var(--ink);border-color:var(--ink)}
.status{font-family:var(--mono);font-size:12.5px;color:var(--hold);border:1px solid currentColor;padding:4px 10px;border-radius:2px}
.tabs{order:3;width:100%;margin:0 0 0 -10px}
.top .status{margin-left:auto}
@media (max-width:560px){.top .status{margin-left:0}}
.layout{display:grid;grid-template-columns:250px minmax(0,1fr);gap:48px;padding-block:40px 80px}
@media (max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}.side{position:static!important;max-height:none!important}}
.side{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;font-size:15px}
.side .lbl{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);display:block;margin-bottom:8px}
.side ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.side ul ul{padding-left:14px;margin:2px 0 6px}
.side a{color:var(--mute);text-decoration:none;display:block;padding:3px 8px;border-left:2px solid transparent}
.side a:hover{color:var(--ink)}.side a.on{color:var(--ink);border-left-color:var(--accent)}
article{min-width:0;max-width:52rem}
article h1{font-family:var(--display);font-weight:800;font-size:clamp(34px,4.6vw,52px);line-height:1.05;letter-spacing:-.015em;margin:0 0 18px}
article h2{font-family:var(--display);font-weight:750;font-size:28px;line-height:1.15;margin:48px 0 14px;padding-top:18px;border-top:1px solid var(--rule)}
article h3{font-family:var(--display);font-weight:700;font-size:20px;margin:28px 0 10px}
article p,article li{max-width:44em}
article img{display:block;border:1px solid var(--rule);border-radius:3px;background:#fff}
article blockquote{margin:18px 0;padding:14px 18px;background:var(--sheet);border:1px solid var(--hold);border-radius:2px;color:var(--ink)}
article blockquote p{margin:0}
code{font-family:var(--mono);font-size:.86em;background:var(--code);padding:1px 5px;border-radius:2px}
pre{background:var(--code);border:1px solid var(--rule);border-radius:3px;padding:14px 16px;overflow-x:auto;font-size:14px;line-height:1.5}
pre code{background:none;padding:0;font-size:inherit}
.tbl{overflow-x:auto;border:1px solid var(--rule);border-radius:3px;background:var(--sheet);margin:16px 0}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:15.5px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);font-weight:400}
tr:last-child td{border-bottom:0}
.foot{padding-block:24px 48px;border-top:1px solid var(--rule);font-size:15px;color:var(--mute);display:flex;flex-direction:column;gap:6px}
.foot p{margin:0}

.draft{font-family:var(--mono);font-size:12.5px;color:var(--hold);border:1px solid currentColor;padding:3px 9px;border-radius:2px;display:inline-block;margin-bottom:14px}
'''

TOC_JS = '''<script>(function(){var links=[].slice.call(document.querySelectorAll('.side a'));var hs=links.map(function(a){return document.getElementById(decodeURIComponent(a.hash.slice(1)))}).filter(Boolean);function on(){var y=window.scrollY+120,cur=null;hs.forEach(function(h){if(h.offsetTop<=y)cur=h.id});links.forEach(function(a){a.classList.toggle('on',decodeURIComponent(a.hash.slice(1))===cur)})}window.addEventListener('scroll',on,{passive:true});on()})();</script>'''


def build(src, out, slug, title, desc):
    text = (REPO / src).read_text().replace('](AMENDMENTS.md)', '](/amendments)').replace('](CONSTITUTION.md)', '](/constitution)')
    m = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc'], extension_configs={'toc': {'toc_depth': '2-3'}})
    body = m.convert(text).replace('<table>', '<div class="tbl"><table>').replace('</table>', '</table></div>')
    cur = ' aria-current="page"'
    nav = '\n'.join(f'    <a href="{h}"{cur if t == "Constitution" else ""}>{t}</a>' for h, t in TABS)
    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{H.escape(desc)}">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="canonical" href="{HOST}/{slug}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Verafy Chain">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{H.escape(desc)}">
<meta property="og:url" content="{HOST}/{slug}">
<meta property="og:image" content="{HOST}/banner.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{HOST}/banner.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>{CSS}</style>
</head>
<body>
<header class="wrap top">
  <a class="brand" href="/">{MARK}Verafy Chain</a>
  <nav class="tabs" aria-label="Verafy Chain and Verafy Harness">
{nav}
  </nav>
  <span class="status">Concept. Not a running network.</span>
</header>
<div class="wrap layout"><aside class="side" aria-label="On this page"><span class="lbl">On this page</span>{m.toc}</aside><article><span class="draft">Draft 0. Not sealed.</span>{body}</article></div>
<footer class="wrap foot">
  <p>Draft text for Block 0 of Verafy Chain, a Verafy research concept. Nothing is sealed, nothing runs, and there is no token.</p>
  <p>Source: <a href="https://github.com/Verafyai/verafyChain/blob/main/CONSTITUTION.md">CONSTITUTION.md</a> and <a href="https://github.com/Verafyai/verafyChain/blob/main/AMENDMENTS.md">AMENDMENTS.md</a>. Comment by opening an issue on <a href="https://github.com/Verafyai/verafyChain/issues">Verafyai/verafyChain</a>.</p>
</footer>
{TOC_JS}
</body>
</html>
'''
    low = page.lower()
    for bad in ('swarm chain', 'swarmchain', 'swarm harness', 'swarmharness'):
        assert bad not in low, bad
    assert '\u2014' not in page and '\u2013' not in page, 'em or en dash'
    (SITE / out).write_text(page)
    print('built', out)


if __name__ == '__main__':
    build('CONSTITUTION.md', 'constitution.html', 'constitution', 'The Verafy Chain Constitution',
          'Draft constitution for Block 0 of Verafy Chain: no foundation, no VC, no coin, no fundraising, no secret team, no community fund, no treasury. Governance judged by a panel of agents.')
    build('AMENDMENTS.md', 'amendments.html', 'amendments', 'Amending the Verafy Chain Constitution',
          'How the Verafy Chain Constitution and its Embedded Ethics are extended: seven stages, two checks, entrenched clauses, panels of agents. Draft.')
