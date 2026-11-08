"""Concepts used to describe pictures: to name clusters, and as the competing descriptions that make
search-by-meaning on pictures sharper (a picture matches "pizza" when "pizza" fits it better than the rest)."""
from __future__ import annotations

VISUAL_VOCAB = """
cat|dog|bird|horse|fish|butterfly|insect|wild animal|insect macro|reptile|pet portrait
mountain|forest|beach|ocean waves|desert|flowers|sunset|night sky|snow landscape|waterfall|lake|farm field|river|jungle|cave
city skyline|street at night|alley|interior room|living room|kitchen|bedroom|library|castle|cathedral|church|temple|bridge|skyscraper|ruins|village|market|garden|harbor|train station|airport
pizza|sushi|dessert|cake|coffee|bread|salad|burger|fruit|noodles|cocktail|chocolate|street food
car|sports car|motorcycle|airplane|ship|train|bicycle|spaceship|tank
portrait of a person|group of people|fashion outfit|face closeup|dancer|crowd|couple|child|athlete|musician on stage
oil painting|watercolor painting|pencil sketch|ink drawing|anime illustration|cartoon character|comic book page|manga panel|pixel art|3d render|concept art|digital painting|abstract art|graffiti|sculpture|stained glass|woodcut print|vintage illustration|fantasy illustration|sci-fi artwork|character design|storyboard|animation frame|line art|vector illustration
poster design|typography|logo design|user interface design|website screenshot|mobile app screen|infographic|diagram|chart|book cover|packaging design|icon set|color palette|brand identity|magazine layout|album cover|film poster|business card|pattern|texture|wallpaper
robot|circuit board|computer|code on a screen|machine|drone|microscope image|x-ray|diagram of a neural network|mathematical equation|map|blueprint
galaxy|planet|astronaut|nebula|moon|rocket|stars
screenshot of text|meme|handwritten note|document|whiteboard|social media post|chat screenshot|slide
guitar|piano|drums|headphones|vinyl record|camera|film still|neon sign|architecture detail|furniture|jewelry|shoes|watch|toy|plant|statue|tattoo|skateboard
""".replace("\n", "|").strip("|").split("|")
