#markdown/tables 
Leading `|` is required, so this doesn't (quite) work:
a|b
-|-
c|d

But this works:
|a|b
|-|-
|c|d

Tailing `\|` is optional, except for empty titles:
|||
|-|-
|c|d

And alignment syntax is allowed:
|left|center|right
|:-|:-:|-:
|loong|short|looong

[Extended tables](https://github.com/calculuschild/marked-extended-tables#readme) are supported:

| H1      | H2      | H3      |
|---------|---------|---------|
| This cell spans 3 columns |||

| H1              | H2      |
|-----------------|---------|
| This cell <br>  | Cell A  |
| spans three<br>^| Cell B  |
| rows           ^| Cell C  |

| This header spans two<br>  || Header A |
| columns *and* two rows    ^|| Header B |
|-------------|--------------|-----------|
| Cell A      | Cell B       | Cell C    |
