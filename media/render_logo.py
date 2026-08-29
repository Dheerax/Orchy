import asyncio
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image

async def render():
    svg_path = Path('media/master-logo.svg').resolve()
    logo_png = Path('media/logo.png').resolve()
    icon_png = Path('media/icon.png').resolve()

    svg_data = svg_path.read_text(encoding='utf-8')
    html_content = f'''<!DOCTYPE html>
    <html>
    <head><style>* {{ margin:0; padding:0; box-sizing:border-box; }}</style></head>
    <body style="background:transparent;overflow:hidden;width:1024px;height:1024px;">
      {svg_data}
    </body>
    </html>'''

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1024, 'height': 1024})
        await page.set_content(html_content)
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(logo_png), omit_background=True)
        await browser.close()

    print(f'Rendered {logo_png} (1024x1024, {logo_png.stat().st_size} bytes)')

    img = Image.open(logo_png)
    icon = img.resize((128, 128), Image.Resampling.LANCZOS)
    icon.save(icon_png, 'PNG', optimize=True)
    print(f'Generated {icon_png} (128x128, {icon_png.stat().st_size} bytes)')

if __name__ == '__main__':
    asyncio.run(render())

