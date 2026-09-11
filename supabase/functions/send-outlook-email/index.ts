// ════════════════════════════════════════════════════════════
// SecureWorks — Send Outlook Email via Microsoft Graph API
//
// Sends email from any configured M365 mailbox with:
//   - HTML body
//   - CC recipients
//   - File attachments (from URL — downloaded and base64'd)
//
// Auth: Same dual-auth as other functions (x-api-key or Bearer)
// Graph: OAuth2 client_credentials flow (app-only, no user login)
//
// Required secrets:
//   MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
//
// Deploy:
//   supabase functions deploy send-outlook-email --no-verify-jwt
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  inspectSealedSesJob,
  invoiceLinkRequiredRefusal,
  sealedSesFenceCheckFailedRefusal,
  sealedSesMoneyRefusal,
} from '../_shared/sealed_ses_money_fence.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  Deno.env.get('SUPABASE_SERVICE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_MAILBOX = 'marnin@secureworkswa.com.au'
const GRAPH_TIMEOUT_MS = 25_000
// Generic sendMail uses inline file attachments. Keep this at Graph's direct
// attachment boundary and leave larger files to the sealed SES upload path.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024
const MAX_MESSAGE_BYTES = 35 * 1024 * 1024
const MAX_ATTACHMENT_REDIRECTS = 3
const KNOWN_GROUP_ADDRESSES = new Set([
  'ses@secureworkswa.com.au',
  'fencing@secureworkswa.com.au',
  'patios@secureworkswa.com.au',
])

const LEGACY_REPLY_FIELDS = [
  'in_reply_to',
  'references',
  'conversation_id',
  'replyTo',
  'reply_to',
  'conversationId',
]

const EMAIL_SIGNATURE = `
<div style="margin-top:28px;padding-top:20px;border-top:2px solid #F15A29;font-family:Helvetica,Arial,sans-serif;max-width:400px">
  <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAACMCAYAAABS3P+YAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAAGQoAMABAAAAAEAAACMAAAAAHV9xuoAAAHLaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9yU3BhY2U+CiAgICAgICAgIDxleGlmOlBpeGVsWERpbWVuc2lvbj44MDA8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+MjgwPC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CphNqRMAAD3zSURBVHgB7Z0FvFRF+8eHRulOaQRFBQxUTEDFBFEBUURFUV9fEztRFAM7sBOxFRWLRpGWFAlp6W6R5v98Z+/snT13d+/e9SKH9/8Mn8vunjNnzpzfzDw9z8mzR4rRoggoAoqAIqAI5BCBvDmsr9UVAUVAEVAEFAGLgDIQnQiKgCKgCCgCaSGgDCQt2PQiRUARUAQUAWUgOgcUAUVAEVAE0kJAGUhasOlFioAioAgoAspAdA4oAoqAIqAIpIWAMpC0YNOLFAFFQBFQBJSB6BxQBBQBRUARSAsBZSBpwaYXKQKKgCKgCCgD0TmgCCgCioAikBYCykDSgk0vUgQUAUVAEVAGonNAEVAEFAFFIC0ElIGkBZtepAgoAoqAIqAMROeAIqAIKAKKQFoIKANJCza9SBFQBBQBRUAZiM4BRUARUAQUgbQQUAaSFmx6kSKgCCgCioAyEJ0DioAioAgoAmkhoAwkLdj0IkVAEVAEFAFlIDoHFAFFQBFQBNJCQBlIWrDpRYqAIqAIKALKQHQOKAKKgCKgCKSFgDKQtGDTixQBRUARUASUgegcUAQUAUVAEUgLAWUgacGmFykCioAioAgoA9E5oAgoAoqAIpAWAspA0oJNL1IEFAFFQBFQBqJzQBFQBBQBRSAtBJSBpAWbXqQIKAKKgCKgDETngCKgCCgCikBaCCgDSQs2vUgRUAQUAUVAGYjOAUVAEVAEFIG0EFAGkhZsepEioAgoAoqAMhCdA4qAIqAIKAJpIaAMJC3Y9CJFQBFQBBQBZSA6BxQBRUARUATSQkAZSFqw6UWKgCKgCCgCykB0DigCioAioAikhYAykLRg04sUAUVAEVAElIHoHFAEFAFFQBFICwFlIGnBphcpAoqAIqAIKAPROaAIKAKKgCKQFgLKQNKCTS9SBBQBRUAR+FcYyO8zZ5k/5s5XtBUBRUARUAT+hxDIvzefZe369ebdj780fb782hTMX8BcdWk70/Gi1ubAAw7Ym7fVthUBRUARUAT+BQTy7JGS2/ehyf7DhpuX3uptZs6ZawoWKGC4yc6dO83RjQ43Xa/tbI49slFu31bbUwQUAUVAEfgXEch1BjJLTFUvv9PbDBj2i9ktjKRA/lglZ/uOHeaAwoVNu9Znm2s6XmwqlCv7Lz6u3koRUAQUAUUgtxDINQaycdNm0+eLr817n/Y1q9euM4UKFjB58uSJ28/du/eY7Tu2m9o1qpubru5kzjm9ucmboG7cBvSgIqAIKAKKwD5HIFcYyLCRY8yLb71vfps+0+QXjSNf3tR885i0hMuYlqeeJIzkclO3Vo19Doh2QBFQBBQBRSA1BP4RA5m/cJF55b0PzXcDh1r/RgHxdcQr+D/i6yLG4C/Zvn27KVu2jLm6Q1tz6YXiZD9QnezxcNRjioAioAiECYG0GMiWv7eaT7/+1rz54Wdm+cpVYq4qmNBctUO0jPz58ll/iHALk0++xyu7du02u3btNEc1zHCyH6VO9ng46TFFQBFQBMKCQI4ZyOjxE80Lb7xnxk+ZaplBIoawe/duA/M4tF5dc2Pny8z6DRtNr3f7mEVLlyf1j2zfjpO9kGl3/jnqZA/LLNF+KAKKgCIQB4GUGchiIfxvfPCx6fvDQLN16zZTUJzk8YooGdZBXqpkCdNRzFGdO1xkihcrZqsuWrpMQnvfN98NGmZ27NhpChSIjdBy7RG9hVmrdo1q1jdyrjjZEznk3TV743PXrl02IGDp8pVm/caNZtu2bShRprAwuDKlSpqDKlcyPKcWRUARUAT+PyKQLQNBI+j7fX/z6vsfifawLFtzFdFUzU44ztwoTvEGon3EK0N/GWWef/M9M23mbMtE8iZwusc62TuJk71mvOZy/RihyIN+HmF+GfOrWbB4qfl761bL0HaJVsWGlnz58locihYtYhocXMe0OOkE0/yk403Z0qVyvS/aYDgQwFc36OeRZvmqVTFBIggUBUUQOveMFrJBtnDSzg79ZbRZuHSpXO+bcfeYvPL7jFNPNOXKlE56PYLMsJGjrRDjgha5/549u02zE483VStVTHp9GE4iGP48epzZKsKY84yCbXFZS6cK3dCyfyGQlIHM+3OReeipF82o8RNkkue1vox4j2fNVbK/o07NGub6Kzua886QsNwETMFdv2HTJvO2+FD6fPmN2bBxkyXI7pz/GXGy7zBlypQyN4gpDCd7qlFefjupfF+zbr15VYICvvphgFm7fkM0oiyR9oOmtEvMdCzi6gdVMVdefKFp3/rchNpZKn3QOuFEgHnY6YbbzeDhI2V8C0Y7SUh68WJFzMDP3jdVKlaIHg9+WbVmrTmvYxezZPlyyzDcedotVKig+eyNl0zjww91h+N+Pvb8K+altz+ImV/4DasfVNV89e6rprwEooS9zJ3/p2nV6VqzTcL482SE1hDSf/opJ5q3nn087N3X/gUQiG9Dyqg0evwk89Oo0aZokSKByzJ/IlEUK1rUXN7+AuuzKJOiFF5CzFpdr7tKJPem4lN514wYO94ynaBPBeLNAmNvycd9+5k2Z50h90vcn8ye5ezbwiVLzW3dHrO+HYIC2OyYXcknfcuXQUwWL1tuHnr6RfscD995i6lYvlx2l+v5/QgB5iEaAml4mI+uIEQwV/YII0lWfhjyk1m9bp1dK349y0BkDhFokqysXL3GZncoXqyo1YBd3W3btpsuHdvvF8yDPk+bNcfsEKZHdgpX8JU2PryB+6mf+xECSRkIkn6i0Nyd4h9g8p947DHmpi6dzJGHH5bWYzdqcIh585nHzGf9fjCviZkMQhwvqitZX9K6sXcRmsetDzxqJv0+PS7j4Dkp/O/CkYNaCQSAv4Fi+lovGtWrT3Y3pcVPouV/BwFMljCMYGF+sB4SFfx93w0aGpW4s9RjUjmbVJaTkQP9BgwR7WVFjKbOPWvVOMi0bnlagqvCd3iaJFbFNO0zTPyp9evUCl9ntUfZIpDajr9AM5isqoi99dG7u5q3nns8bebhmmXz4SUXtDJ9XnnWXHhOS2s6ckTb1dmbn2yCnDh1milcqFDMbXhOJDzMcUiZ2GmLyB4VmCpSE2lZgoV64yZNMT17vWGszyRYQX/vtwgUE008OC+h/Xvk3+7diRnIuMlTzLQ/5th5nejh8zrJJE6Fv7b8bb6W4JWg6ZYgjw5tWu03gRz0d/b8BTFZJ1hjpUoUN7WqV4vz5Hoo7Agk1UDidZ79GhXKlzXvv9DTVKtaOV6VtI9Vq1LZPNXtHoMZ7M0+n8ZIW2k3ms2FM2bPMf36D85yL6SkMqVKmfNaNjcnH9fETnDCi3cJoVixarWZNHW6+XHIz9bkBYPxNRIY0beyufLCc880xzQ6Ipse6On9BQF8HXnjUPqIBiIBFgkKxH+rBGIEBRRX3foCkmggQ34ZaWbNWxDDgNA+aojv4/yz9h/tY8PGzQa/aj4vPx4+pPJlyuwXAQBuvPQzE4EcMxAuRdriHR9EI5UTx51vz8xsOv1v5WRCBSW99FtLfuUQiQjDiU9oritucT7/6APmUImyCpaypUtLhNnBpv3555o3P/hEHJu9bX8dE+GTyK1vfhykDCQI3n78m3D0oI/OPo5YtZCu4xVMssPFv+evEea2myvumkS54JiLn3/7o6w5GFSmn2TXzl3mkjbnmdIl9x8z6eJly8yqNWusRu+eG4Hs0Hp1Eob0u3r6GU4EcsxAYBpr1q43tz/8uJhzDhRTVnlLTA+tW8fUqVVDIrGqmRLFi8fYOHP66JHFktOr0qs/4bdpMRPatiIE4eZrrojLPPy7kGmYqLP5ixabvt8NiHGuYuP9bcYfZvNfWyQI4UD/soTfd4hJbJsEJWwVsxk4I7ES8RM0XSRsIMkJNCrMbjuF8CBF58+X30bzBAlZkiZCdQqceBZCaBP56fwOUx9zJEEf1McRHs/X5l8T/F5CHNiMa5AB8DsRAyHNz2qJwOJeFLRVHPGbNm/OZCJivko0Dr9O/s1MlDnq75niXkT9nX/W6cEuxv3N2GMGI7KQ8FmYFYEx7GHKLvQ4boMpHKSPmHhxGWHWRcGaKuth+/bY/V+7xaLRoH69FFpMrwr+p7+3bTV/yTrEpIy/pajQLdZWdpGi6d3x/9dVOWYgwMNkZ9GwCKb/sUmSKP5hUWNhECGFPfOw+gdbxxgJEmvIZIfZJFokQciRuiCmSG1ck+p1wXay+83CWrV6rSWori7PVaTIAeaIQ+u7Q9l+XnB2Swn9FTOFLE7XV6JyFixcbNZt2JCUgcBgRo4bL38TxE4+25rHIPS0A56Y9Ro2qG9OOOYoc5S8SyUnzIT+jPp1om17+qzZZtmKVZaA5smT1xQvXtRUk42Qhx1Szxx/dGPxYzVIuKA2/fWX6S/mum2yJwhC4AqEmJBtCESiMkl8SxAOX3JnIRM8EcR4+JhxZsGiJdFnjBCfQvYeLnSWvTk/DB4mGvBss3TlSnNl+4vMDVddFvf2hM4Olz0HYyZMlvfSzBPBZ52V5MG2mJijalY7SJ77UBsIkmjPkt+w00CCzCIRA/lbNtwSfeUIFQzvsPq1ZY0cKOMyyTIFXPKYsNy88e9Hu599/b01fxXy/HO0c7Fov8kiHukjzOeXMePNhN9+N0QZwkQh2NwLAYXnOVzGv4VEQvKXHTOZIRFUVuCSa22R/tHWqU2PNZUqlLeHZsyea6PFJkimioVLlsn8rWTee/Epy3iny/X0yzFDno+8d3VrVfcfO+Y7lo4/ZS9WvqjpMDIBt+/cYSqI9aNJ44ZZsGOj8yjJmMGaIsHr0hUrLT1hPiE8MV9rVKtqjpG0SezfOkSEXy3pIZAWA+FWTBz+RKAS22xEtWZyrBMpZ9zaKbJAJliiAePASVa/Tm2RNOqaujVrmHp1atoJl8gmXLdmddPkyIaW4G3a/JfdAY5JCKaSmwVGFc/5idSCxJJqqSP9bX3m6ZahOmJhr5UJm4zgE1nD7n5e94tJAhz969et32gWycL/efRYyTv2qV0sN3TuZI5umH3EG4TzBQkO+F2IN8+TL6NtR/9Xr11rZotdnaixIsKojpGFCCE+6oisba+VKLUesgcBZuj6x+InfBvikYyB9Jf3wrzw5rsxdWBsd/73miwM5KO+35pvBwy2Whf4oYkSOsseAaKfnnjxNfPJN9+b7aJJ5BfNA7/CZmFuwUL7H335ren9eV+bOoeNdgRq+GYi3pY5b8EiM/CnEab4ux9aQoI2yfxMVHLKQBAMZs1dEH0nzm7pxzmnN7NBFjje/cJaChYczmy68zUs1hi+xwsk2CRRgXC+9v6HltjDxJhXkXnImo1cBTHlFQwIOUSINT7sUPPgbTdahpKo3Q8ljP7tDz+XsYyYexkftOtjRLBB23hFUhX1/uwrmScbLcNAEIJIo7Wh+c2Zv9AyLtc+Qlap0iVM7QQO9P5Dh5sHn3zOrJMsEJljl0cY4TYrpPbsdlcW5sE+nVdkPKf9MUv6JNpOYE1xb6IkMS3+PGqseUvWVbtW58jG505WK3N908/UEEjKQJggTFiIRbwJHrxFJlOR8F9ZsBQmzjJJuEgqlAE/DbfEAYLFPgmkvkPq1rZp3OuKpkLYK1rHaSefYP/wTcyTjL9/iPSIBMncdwTMNv4P/0OdRbLzlzLPAAF679MvDfs5nOkh2a0gcs88dE+yKjHntvz9t3niJSGGX31n7w1WDq+YivIDSRECwmJD+kaiv+O/XSRNzPnBqtHfb/b5xDwve2vQGArkLyD+nQiDj1bI+GK1AmkbjQDpn0i0+2/5r2nb6qyYqmACs4dROPyZExzLbl7wXFznMxmugaAHC2NPPadtMP/4nUekxmdfe8e8/1lfe0/nr6IvwfuzX+L+J541Q4aPsoST99IkKk4rgvh9I4EU4yb9Zh6581bLTOJdwx6M/DIe2wMnmT8El/gFfL4WHxhCD+YyGGA58Z21EIl3uAgEMexCfgSfg7Y+7/djZJOtt+8Eoefi1ufEzXqA5E1E4XuCE0wWSd8Re79vfI8wEmEsQtwpzKtr77jfvP7Uo3GZCELIfGE2aOfOn4MGzyZG1jKYfyG+msgYRhjMTtnvcYRozxTMZwsWiQM9434c2yUMtWqlCuJHzboD/4vv+pvuz7xk1yJzCDwpaFEIOT0fvNumOrIH5T/W7POvv2velXWLlgXTTPTsXGMZqsw3GOzrIsQhHD127+1x56W7h35mRSDrKvbqEG1FpAeJELdkaABMACQKJny8Se9dbr9SJ7LhDrVXCKFMBNqau+BPyxhYWKjOaCrVRbI6TLQUVMq6tWtayQTJiL+9UfKKKad61SpWzfXbZxH0/X6gmJPWiKngHPsaXpyVqTyv30687zDUh3q+YD7/7scsBBhs+AMTxyzdPfmEmW3dut08+mwvyxjaCyEJlg8+/8o81etNS+jdQnd13CK0vxm/jBOZbW813Z99yfq1morJLAwFItiv/xDT5/Ovs+AV7B9E6pYHHjGjx0/OQjyi2Aoj5nkxZfjYwgxXCfO5vfvj5qUe3cwJTbI+Pz4Q5j+kzGFHH/YgaAXCeIk2Gj0BM1WEgTHupzRtIvnTKotNfpuj4PYRaEu6FFNghANEAkfTcgVhjvxrF5xzpjsU/cTHcf/jz5hvRINjnvi56mKfPSKEuWd3DcC0iS585NmXzfticjogkJZlw6aNZr48E2vfFdrFWvBUr7fMl0LwEcbcY3AOE2zdmjVs9bkLFlqNxwkgHETrPlz8H5kz0Va1wlvPlyNh8NH7CUDkomsuKVsg9P6uewQAmM0nX39nnz1fBmYIIDA+BCSHLwKVs5hwN/qDkIIAca6YY4m41JI6ApmzM841DNbxRx9p7afYsf8Q+ybhhCwOUpH8LWndGZyImghTYSG4KRSnQTnEeVtDJqKTRhjojdLelGkzzIQpv1uJk8nHgiX/FZrKwcJQ+KxV/aBs7xH/zvGPNj3mSNNPFl2wMMl+GfurNcWhYWCvx09wiESM1Ktdy5rlXP+D1yb7zRsbv5DcYoULRRyLri7SHJMZLaxUiRJWc2P3Pf4H3/yCRgLm7DMhQgwbtiv4opDU8XH4C5Xz5DRDEoZQYkrZIgSHRe5rAjzP36Id8S570uqnon25e++NT+bK+g2bTC95RTJ9ds9Evyl8uu/MoacEE7In+NoO9aw/TQgkCTAxQ6EBgu2WLVssgXdzFiw2bfrLPCzEqE+vZ2KIFO1AlCGsG8T0IyBzyBZ6g2bgFwj5ejFBul3rBQsUNCQFhXFB1DKv5qpMZubagKAtWRG7cRCTEEJDUGLnOIyfezK+foG4IkiQp62kzCvMfivFN+Se3a8LE8FhP0jMQK1atvBP2TVPQlE3BpwEr8myZvEjFpLno7jxgNnhpGejIwX64cbBHuA/AYFs3a5wLWYwtCjGxJl/OQ5mF517ljWzBYNS3v34C3m9xPcyX9GII62xnvARHXtkI2G6Fa3ARf/xC5Hrzl+73Atz1wjxF6XDQNA+aYOx/f9WkjIQYrTRDtgl6naKMpjYTmEk7Cr9Y+48OyA4zP6SBYkqCYuAALvJ5hZoInA5HxkAybclk5LCBGCRIxX9NGqMHMljHZ7vv/R0Uqe0vTgH/7UQJllHXq2Leu6ce+5yFh7PSz+wlf8oEiF4wNjqCSaNRDOCiBPSW6FcmZhJ6drwPxcsWmze/ugzmcz5oxOd8xAAJLX/XHGpOVEk38IiEWG3XySYfinMhsWxVSRYt6D4xNf08tu9Ta8nulusIaDYvWHsPhGBuO2Wxdyy+Ul2AeKvwQwwSQjFO598aeaKnd1hTl8gkjByCAnO9X1ZmBP4viD4zCWICAXHK0ILxZn+YByYjPxn5zzX4E+75rIOdv6gEUDc/pgz33wkNv3vBw+zY+zmKHNgjmBCnrZ7bv4PTUQLRKdYkaJm2Z5V0WN8YY74JiyY/kDx/TgixVyGUOJngqDz21JPe3Hkq7s/h1hHPItbPxyj/aqifbDRNlje+ejziAYgBNSVSJ92mZMkU0THi1qL30wEAkxpMk/QBsj6QHJIXxqH/OGbwSdCcITfJxtBlcGM3D04z/uA+OSZmGuYp5lP/CZIoULZsrb6zNnzrGbtrkXLJp0RGbcpjNPTr75l3pH1wfXu3vSXZ+lyWXtz23+ujtGAuI5neUvGinGTbtji8H5KzFx1a9WIHMz4HyZyV/cnzdARY2LWO4LZn+JvTLVgHv7p1ylm8oy5ZpWsxcKybiqKKa7J4fXNUQ3qRtdqqu3tr/WSMpABw4ZbAtZQImYgPAeLNlBFbJYlihezjjOcZxSkW5ySRFnwB4efNW++WSkmIBY/TIUMpNaRK6PsJkcy0KjDH4uIRb9dJiSLj8mUmwUppet1nc1tDz1uCXlUZc64ietHwYKRyBMmNKYScnf9JE44pHScycSyo7ERzZIoKyqRWpgmfAmZyV5btKo3JJ0L9mC/wKTuvfl6q2Xc0+NpS/gcdtx3pAQqTJ0x0+YRAveREnEV1BqQ+i6VXf7dbr8phiDBNI9ufIS58qY7JVhhZZTYQdi2bt9mnbf7moGAhcMfnBoddohpLaGrDUUbxKQI44WhQ4w+/upbOz/852e+EL3W64mHsjhIjzyigeGvZvWq4uR/P4YwMd++E8bS+ZK2IhhECCB9YW4QQRWcg45YU4fyk7ziGd+dI85ojG3OPkPGBpv71sj1nrDKV5np9lr+Gyz+m9kioDnmyLEdEnXU7ryzTHmvPxyH2cMMYFaOgEb6s9tcdWk70/Xaznb9UNcVtNZnHr7XdLntXjNGGK8zs3Ge8G6iAUnv42eXninWB3wLYoWOKYwPDBksz27RTDT1ehL4UMZqjLTFecxr8/5cGIMxZj80begKmDz6XC8rKEUYQQQc2gWDW2V9XnVJu5j7uh+sqTWSY8wXHMD7WhEYgsyDa0rKFgPm0PeDfxJMM81xMARoVSpl5Zr1ptfH/cwvE6dKSPABpkKZkmbl9p1m/LRZ5ptho81pxzU2N156vjkwI9gglTb31zpJGQhObCTvoSNGR5xjsljZnX3SsUebO2+4xto4eXCkVhxp/EFEKUyKpZJ+mjA8QvtmC0OZI5k4rT9FTF842JhgcH5HJOyFCf6zi8ytkAR10j18ZvNTzF/Spydfet3G7PM8vvTnt+v66hgbi5VIMSJfRoiTm8V8cetzhfhcZBmLu5Y9CODoS/uco72bu1yRhXm46/g874wWtn3yhbmFwnVb/t5mo6hIRAdDwwzoMycWYI2qVeyelnjPU1P8W+3Fx9PjuVeiphbuB9OZLlEsXO+kaI7vq0J/Wp15mg1qIIY/WMhwO1bSx/gEl3EpLoz9rhuuzcI8/Ouv6djBYjd+8u9RiRQND0Y/XMazrRBtVyIaiKQzEc3cL/wCKwoCBuYnfsNw+F1RiH7LU0+y5xHT6VtsQViKHCFEF2c017mNgxDEKhUrmovOOzvmMpjqi2Ju3Cjh9EHGSVTg7dd3SSgJM486yEbEXyVwwC+YYYhAXLJsRZSBsJbniKSPAOgX9xz/lei1ay+/VOZmxIzl1+E7mwdtGnvBwxU0qvp1awlOu8UB/4x9R5A1g2XggHBA6phut99oIxzddf4nmjQmKaeZu3OCpn31BBjGm/fsWYMpZUZ2RUyQmKazK1gCnnr3M/OrMIuTjzrcXHXBmVbzAIsZ8xaat/v2N/1H/GrKlSphOsu5//WSlIFApCCmTE7mPESQsD/MKzde1SnKQOKBBCFDPeWvtSx+AGbPA/Hos+ZIVJVoKUg6mAs4jj8F9dlnKvHa3VvHMA2w3+LDL74RpvmLJSAsXIgSkxAs4hWOc6pg3ohohnbywpvvmTETJ5lnH74vGh8/R4IGWJQwTFcgAIQ3nyZhqtkVCOg3/QdZHF1fWAAwaNrBdxQk9hAj3rGQbLfyaSedYENNkQhduziESU1Ou8E2s+tnbp+HEBPpc59Eh8VjHtxv6vRZZqMIO35f0T6anXic1QyT9QmJFwY9bmIsIeXZSVfjMxDwKSpMCX9MTBGG4nwgzGmImgtgoB8IKAhXFOa4QO0VWVgyfxz2zBv2bRSQdecKDJRgjooS1OIXNFDC5fGvuMKcrVyhgrldzD1BwurquE80ERzfOPjd/TkH8fbDo9k/8+ci2Z/jMQDq8WxXXnyRCChX8jNhYf8ITCj4HhQyOnTt1sMKVj4DhPAfJLn2HrvvdnPcUYnNqAi4SyXBZLBfjCkvrgObE0XYxQ+CpuOEK/aA3CaZwNMpP42bYibOmGNObHyYubdLhxim2fiQOubOzu3MTY/1Mv1HjjfntzjBlC5RzKyVfq4SraX2QZXNZtHGJs2cY6pUKGsOFu2XAo5zFy0zi5evErNeEVuvTMni0e4xHguWrDAlihaRtC+ZmQfYcDx/yXJ7jwryugvMgPwuJXu8DhT6O1PC1NeIH+6giuVsm2y6ze2ScosQSWY6g4XK60+4VDpFfTYZ4gjnj8IiJSZ7rqi3syVenrxUvGRqweLF1iyWSru5WQezDqae6664xIyVzWfY1ccLYV6xapVI+xIwINJSdgEDLNp8orqyee0BiWF/6bGHZOIWEuax3PoncFS6AlMuKFLbYNmLgb8pUQF7mA9SI5PGFcYC8xPSMhIeUWV+QduBKSYrqPnPdb8vWZV9eg7nZlPxxZQWh2yigm/Jvgr5gEwJFykUOv+jbORLjm0eK9QgKPkF7YE9OEEtLEtCRRmc3fyTuUHBd4FGylghNBFdiDbgF2Eh8Ixo4TuhyhT8XUQbuY2DVvsQYnqhpwlRj7Yx3yCFO62U4zAb8mNVrhjZ2MexROUA6SPPmTmjIjVtfyIL3h4ghJ757zuJWQtsHuxy2cWJmo8enzpjliVu+Qpljo81E4qvBX+PzzxYBbR9q5jekjEPGofRUDdYoDUw9BFjJ0ggzHg7BpWlr5iZ2eDM5kN8ukFrQLCd4G/mwrBxky0NOL9F0xjm4epWk8wct1zWxqxYu8H2j+MjJv5u3u07wLQ78xQzdOwkM3PeItFczrIMZNaCxabXJ/3M7D+X2CYY1+JiJu1wVjPTunlTS2fXSSBJt169zWF1aph7r+ngbmWWiovgjmfeMK2bNTVdLjrbrJFo2e6v9hHN7QARU4z5c+kKW5fxPKSWvN21YxtTvXKsmTzaWJpfUmYgabaf9DIGEDsrf8fKoFLQcl7r/ZF5UezSLoIlaSN74SSOv1YtT7N/2G+JX58hTkAkKZyJaGEbMzY4Iu0EJSC6hLSDj6T/0J+t/Ztd0Uz2CJmIdJprp4vE2lXeQ5JKYWH4jJsFjfbGDnM0OH+BM4GwwSfyx6RyvzDUQWOrLdJjsrJCGKiPC3VhCGzAjARgJLtazgVwpXYeEQQQboJaWNE4PhDq55V+/iU2dHKrOVMaEiHhwGygdQWhASIRW9D0C1oT7wgxhRbwhIyd0ka7VmdbM5h/zao168Rsl6npcI52SVHCxstUCv3FlOwXeob2g4PblakzJQXJjgCjEuEPczW7wZMViDwbIoPjw2+rlQgD8wvrg2t4tcJ5gUgwvx7fifI6SHa6r1i9OoYJcY72nVAAU50vPin8siROhanjX7xImDK+KTdeXJesbN4iEWySxglneb2akegy6seMqTzAqU0axTSDyfNvoWsffjfElJQAnA5nNzPHNqxv1kswUk8xhy1cutK0ana8OODrSYTcevPxD8PMK598K/4a2ah7TEPLDNBC0FT8wngzxxAyKPSDvTVzFi4RRlHRdO10ofXRjJg0zZrVnv+gr+lxc+dc9c3sUwbig+G+wzQYYFT9MBTStxNlxR+FyYiDEVMF2skw8WugQaF5BO2tDDARLUxSJK3gIsrR88mCyFok/FCcf9jAmWAxRe4NEcTBv78WFgQmzVLZJAzEZu8k+HSeNT6yCDPbZHHGzkP8KjHjLJ3ElMicHST+Qvwx7DWgwNDbnN0yYEqSmc2DeYV6mLy++nGgNcU5wQlCiibhm9HcZVOmTbeReH5fICQ1xPRIsEsqZaGkCIEAwUCjRdogkqpShgZDX7EOoNG5wjE0FwIUsiuEPBMpxTgGS6L1gGA5ZMQom2fOd+QHr0dzuVoCBRDC2FvjzIbBetwHIc8JehBiNs3yR7Tco/d0jZoYg9f6vzE/rV2/SVIAVTDFhC64Mn3un+b9bwZG5wXzgZdmXd7qdHNY3chYMDYVy5Yy3W+43KClUL4aMtLMXbjUnN/8BHPDJa1dcxK4Ucp0e7m3dcifJH4W+u/+opUyvtjj3kHGhjl6h5jS6tWoas80OaK+FW5GTPhdosbmmKaNc+/lXbE2D68jufmVOHHCTlMtwQWW6nX/Rj1Ub+zZRFvdJYEEn731knn4jptlf4HYxmWS+IWFgPRFaK2sUv9U9DuqNloXpoikf7JAiGYL/iHFWckkliZF2/e1kujB/eYLm/6M7DGIEORE3Q7i7upBHJNimoF5EFP3G7ONyHWuOfsZ2Y0eKzVDmAiVRlhwDnbGlZxwJx93TMz1/AjwD0vYiCSCAfmOavqPlOz8J35D+L7Ybe4XNuY1EBON26nvn4v3fcr0GRYff2ZC6GpJ+C3phyhouDjQXUQZx1ifNj1R3dr8TFp4CRah+L7vz78ArTy43qm7RMwvZF7IrqBtvfz4QzacnnXAeDMfgm367UB0YTas5cGiMWJqZsyzK6wlxhqt1Pm8uIb7rl63wawWGofPYc6ipWbc1D/E9yH7hTIKY9P82EZR5sHhOcI80H6aHRuxvri6jcXUVuegymb5qrVWS/GFBFcn0Sd41qleOco8qIdw21y0IoSheYuXJbo0reNZxYK0mkl8ETb6G+55yPo/nn/kAdnMlOkcSnzVv3OG9AVEivnRGISE4qshiWEqBW7Py7AY5Ad7Pmfy7Mk0MzFwa2ViISETbhokRixWNiiSWBD7ak4LpI2FwAa5LPxJFgnnfZ9JTtvPjfqRheaTqJy3ChNJViCYQaIMAYF41xBHpfNPJGsjeA4ihOYTlJyju9GlfQgRBVMJkYaTf58RDYmFyBD4EHz9Mv0MEjck6WGyL4GkgUj2FO4P48B8Fa9AmGNZm5gv5BqSF6ZSqGs37QYqM17Hic/JPRvrd7n8+UQMnxJ9q5KCn2XazMgGwnj+BrT5alWriKlQMl2IdO/u6brEO3XIOBw87s67z1MkHxuJRn8eKSZj0Sgm/jbVhtojXNmgHDHl+mvcXcfo4Z/E1IzPkrxuyQovlCsvubtWr9toVogJsUpGUEPDerXNa91utpfS1979BpkP+g2OuScWleoZmoe7B+ZxHNvBlCswa8KDF4lTnUjLHIUDy6QoLtpwsGAOE/5nNmzeEjz1j37vVQayXJzPvCqWhQXxvOvRnobNPUhxYSg/jxpn7nrkSeuvcP3BFMTmQNI5sGEt1cKO/TIlS5m1wpRI3eIKjIEFF+/1tjvE/ESalvtuud5VT+sTkxqTzico9ACpGAc7z5OoQEjYfW4JsOu2NATBgOmxIBIt4CAhjHcPwrbjLd54ddM9BgMNaiEQwjMkdJYw5dwszF2k0CjDF3x4vh/F10XkErjRFyLfzmlxatxb+7iBLcSTDMNEdwmps9cg1V503pnRKD6/Ia7fKNJtZoZadxYfSFbi4c76n7MlCtJneJyjXUyeJx3XJFoVUy1SvTP/cIJnxyEdjylEL8z4Mk0ijogGDNZF4seH8kDXG+weEELcfWc69Sf9Ps3mwCNfXnaFCD0SVfJH+vzfpd9k4oUxkEsPKwBmOPyOfgF/mD2borNjIEVkPRwsO+v7/TTaDB490Vze+gzblDVBZkRhEvQxfe7CuGsmGOZcSvbT4RtZJ742v5CfC4c49yPyapvMhXhlozCDHYKt3Cx6GlMufho0EV/rW7Jyjd0vVSaXBfi9ZsKCcHV9oIf5dcpU6wwnqmSw7HxlQ5wfIhh98n3whbQWEBpiu52pg8XB7vo/Fy/JUY+Qprg2cygjCxLpmEnLXgDs5Gg4rjDxMHEFiZ87n+onm6MgWITi+oU+kcY9WSHa7JxLrzbnXdbFtLrsGvt3Vocrzd3C7B2RZDHHM4XBbEngl6hwPRvi/ImcqO4/OV61UiWRNGOnMiYDovpyuxSXRe8TU8abBc9zOikd4k+acN7ZkbXgA+FoZKZAwNi5TkZm58y12ofMl3Zxcp259rKEEtsWI5v2XJ1kn70lZxq+M184oN9EKDUQ5uAKDMT6SdwB+eTemMqyK8w/ct4RYOAXhBZehoVFglx0zZoeF9MP6jLfED4GSYRisEDwoSH+H5FvzgxVVlIPwQxuuvpy01syV3z5Ti/T4+7bZMPtoXHXGoyFPqVSLjz9RFNW9nj0HTTSDBg1PuYStP3e4guZNmdBjMkvppL344iDa9pZ8PWQUTY/oDs1SJgTvpE61SoLQz/QaqXsdF++el2UmTBHBo6akEWbZa3NFRPaz+Mzw9I3igVkgOxNwRRcr2bEL+Lu9U8/Y9nxP20t43oijm59sIfshZgSE+qGc7D/0J9koeSzMd7ku9qXpVrVSqI1lBS1bnN08bOgUC37fNnP9BDnWqqFjYRoH74jDwLKfopiIhXWlN3mZUqXtBFTeTPMFNhgkQKny/uyDzsk+YIkrQn7A3zixSQqLxEhaD+YwogQi5H05FmGj/7VdLm0fdS0Enwe9iwQBktuLsf9yJfUVKKHXFtId3zPZH0IPTjwt9sAAiJh4hVSycMg/T7Hq/dPj7EhDW0R6c9pO0QSsREQ7cya+JLcBCcsqXn8fjJ2NatVlTDoQ2KuROiIl5HXEWIwIqy2zVkR6TTmYvnBefZROazdeXc9vyHkvA6ZuROvUDcojFAP/wlSd3Zl8C8jJW3+kJi5ivaBBnDFxRdE1wIYsE/LFx6ox71JophdIa273ZGfMd+pD/HnHTRkunZ4k2SSMcLh7saPugQjDBCT1NWXtIuxBnwioc5vSKQm68cVpPRWZ7SwG5zdMT7RzEkIy99ppzQ1Ha+/zTI1N7dtXeHlqb6emzDYayRk9tVPvzXPvd/XjJ0yU/ZYVJL9HVvNNAk2QPsoL+scExdYUfhkrbrf9qD8d3zjQ82xRxxiRk2eZu59/l3TqH4te93P46fadEltJewXMYOw3JpCq0bIzvfH3/jY1JL7zZBQ4Mmi3WHy9IVSywxF+3jxw6/MJHGYsw+FfSdTZ80XH0xjc3iGU9/14Z9+psVAmMAuUiTYAfJGEZZKJtKgykZdNJF+A4fIZM9vCbQfw+7aihlcd3AvfNaoWtWG87HfI19GqhJuAxP46ocBYj4oZ6M84vXRdYdJgd2113t97GC643yi3bBL/EBZcBgWjjricHnN7cBoPXD8SySpJ19+XfaLdEvoHyL32N09nhJ1XNJOCG6uIHF1aNPKMhAiYshGKrMU6m6r8Byk6SY1NruOgwUtkXeS8Hy+lgAhOcUzY2DKImSSvEdCTaLNIJmyF+GU45tkkSCRHp+RxI6EFwfNBtEGcunLwbVrST6zGoZw07wZ+OB/Yh/H06+8aR65q6slJPFuRyTSTfd3l41y8tIiT1ImsOFeMS0GGUgJMfFA+Bh3n+i7tiGQJN1M+M4WGZ4gIXHX8gmhIX1K+9bn+oezfK8qYZoxHF1qMDcw2fASMZKExivM9W6SDRom5Qg49Yg4u1BMZn4WZhtBRQoSb85FzLHFbIBAvPb9Y2TvtSZMb86wJkhF49+b/STk6uL9Hz5dgSGyAXfMpMmm+QnHR5smjP5PEaj8dUmYMdFeyQoCqx8MQF00DzY0Njw0VlBI1s4ZTY+ym/N6fzPITJg+24yZIiZ6WXIlZRPgZee1sPmwer79WdS3gQAJUwm+WqCwrDOipT7+YagZOXGa+XLQCOsTOUKI/GUSwdWgdoRJwyQ6tznTarqTZs61GxmrykbEK89vafeVlPDMljD9BnVriH+mjBkujAgTV4liB5q2LU82Hc89LcvzJ3vOVM5lUqNUaksdpBHURaQAJFM/3JaFwRvYmMCAk6gw8BDSnZLfhwnrLygWJZK2cyYmaiM3jjOZyG4Ks/MJAn3g94tvvmeGSV4jbLWkmS9ftqydBOTNIWpmlkgcvDQIMxDmHH9RWGe8xOT7IZh8Z1+Ify+kqDETJ5trbr/PXH9FR0m4d7j1yZBRl0U9bdZsu7N9rNRhr4AjGkixLAh2+VMgGOz6n2cjZjKHlWfpKQyKl0LxEiJs+CwabODPv/GegYD6BB6mwAu/YAqu8FxsvApqOFzHrv27Hulp3yFC4AH5hIjh5+VQ5Gny23bt5fYnC7OtOJsnS2irz2DzC7Zffj/AErEuHdubQ8QX5IgOjG2sEKZnXn3HvgURZut4L0wAonaW7CAPFhzm4M4u6HiFsSWrgS8dB+tRJ1GBsBP2bRlEokpyHFMTSRT9wlijFd4jwgYb8TDjILCRWWCZBIuwyZEXcm0SgcQnpNyzTq0akhPu6hgNAM2UIBDmoiswuOoyzsnCa11d5gvrwtfKeXS3kdjVw/THO4B4uZlfEIO4/vtBw2IYSOHC8prn/LJh12P4hfMWEnP5b5JHbKRpJtkX/LVIm5jrXpc0Q5gafYaIH/Lk44+x2qZ/7+y+szGvxy2dZQ+KRJhuBE8xU0uYbvEMYv76QzdHadipTRqaEyR0Nt5OcJjOf9qfZ64Qf8pa2TBY5MDCEoZbJGYc6Ev1yuXN47deZfeJwKxIlQKNbC0bGhGWXLEMXrSOW2UPSCdhQlvEvMqu9hw54l1jKXxmUpoUKlOFwWZSITVHiFnWxeA7wxI1CzH8QV6T+uOQ4VLFb4MEivFfOJSorX9y/IxmJ5kzm51sk6v50RAsRiYFJoHJQhAhPAwYTipCNZGk8JtADFggwQlLiOUV7S+wpiXXv+OOamRatzzNagr++xYgeqTNuP7uB230F8SDtA9skIIh8P6U6CJkVUlBQr70wtZCSI6wv2EMl7e7wL7YJ5/0if5TGC9s9M8LM+SFTPhK6DeaIhqMT+AdYyNzbVGZxH45Xhg9mkxkrCJtu3v0FW2NHd8QTezjEGcYKHjBrPwJ7reZm99bn9nCvs0QRut2cdNL+kB6cjboYZIieojnZGc/BBJm4bAFMs7R96subRuXiDPORFYtXe7P2ciT8KxVZNd4i5ObJnw0BC6Lc5wa1iQpiQg7nJ9VWwxWJ5Ep6TlIcugzK/qHpogPi9cQYBpijwSJTe2rAeS8zzwg0CQ15B0blQQbv2CChCH57TPv8X+4sffrB78TmcYzuWKFKsGO8OZgQYNG88IB7nxJ1GFtjBo30b5B0G2KRRCITYsSMakSjNBVTOdo/WBDQAHOZEzqCDMkdPTXKc9OFu3rOl0S7E5KvzG3VZLr+QsWN6c4zvzPJ+b7ZAXaU0X+khXaqVSudEyVYIg7s9JhDuPI2rOYy//xjxwzEO7IQmNhplrsA8lFvn2Ta31pMdW2crseA036Egjq2Ayfjb84XB95hu3eYqAf/iRx/YI4QJiRXskX5hfavUP2jiyStCZoLjAldy8IOdeyY5akkxAaO/EE5+B9aP8EyfFDsjx/sfFudl6BShZll/eH+1OHP3bPW8k5Yyzcs7k+wpQubnOuOee0U92h6GfzE4610VwzZs2N7vB1J+kfhIU/Cos0rzwL92wipgk2bEGo3bO663LzE63gkbtuNdfd9YA1ZThNg3vY/sn9SSmOUxjGgh8KfH1pFPzBAOd1J2HG8QrzPks6k4yKOI2JvCLhaMIiK5z7xCtO+0jkU/Kv4XmvkDxUMAra87F1RBLCyR4MzjEWwXnE/TBNEhmJCSlYYAAQYBneaGENJ4vqcxXRRO0GW8HLFYI8SgtRwx8YLOWFCB8rwhBakhMAqMMYrRRBCkvAZRdF3sKJts1eFRiCz9x4RpgCOcJ4pbMdaGnDRV/5Y818ZI48eNtNltkE+7O//ka4TTS/9sYzZeo+e6N1aZMQPtK/s7sV+1wYC5IaPogLzj7d9pGFFRwEFmHwz38W6mP+YcEhQT5x/53W2ejX4Ts5nZ5/5H65V0tLcJnwjp7QPosfMwlaHBOeY66AH8yDTYzPSaJGcPUL9uPu4pxkgVktIMDwWPy0z6KMbXe3JZykjrhX3oHhCJDfNs7ju2+6zhQTlZvd78HiY0M/eS40MFLJOzzByP0Fr3e/I+chshFCy+9UCylP3ni6h90hDU6OoXE9/UPyBle0XxiBjwEEhbl6qbw7gwywQebq+gA2RUSyRZr2C6YDQmCzS7/BNfGeCe2FV97CwFMtmC95vS0apZM6/WshqMwh+uw/q51HopXCCN6QV9jGC1+FkSLIYCaKjEVEsmX869TMqkH49+U7AplNwCh9cNfzjNXF7+g2KQavOV3CrukryLpr+MSE9p3sCWGMKGhMvBuE+c488wvPCaNEw0eI4o9ISDenwYnIQdb8093uMWe1OMW/fL/+ThLFO69qK/6Of++Z0tJAUkWZwS0vKvmLPR4U290aKy0xeG4wU23n36hnJ9RD90oeoZOsqee3GTNtfD59jSW4jqCjI8iiEoZBPiGkGd6FwDsYzsZ27hH+YP+xHz/V7W77ilNehoMZwsbKixYS1NIgNpYQymdlMY8ghV3W9vwYDcNvv3zZMublxx4yL7/zgQ0EIBIGYplXTGJ+l1iY2MZheGR57dSujencoa0lsH57/vfIuzUeNk+8+KqEB0ekUwiMJU7SHosTExapx6/tdLH0s419aRH957kcEYOQQHCDBcIW+YsQBfpIiUdwI2ey/s9LjF5/+lHro+vzxdd2cx7UCObh7u+ugglAlCC0mDxI7Y7/wcfJ1XWftIH0DxP1k1fiF2t+4nGmfu2armrcT2YN6wJhg/tGimg+cv0V7S+0Ya1xL4xzkHG9X/ZR8E6bD+SVv7yTh41zhM26Weou41l3QWyl/5UluqutvN2vY9vW1qTp6vifq8XHBwOh7MrIl8W4VSgmr7kWjLMrRBbid2DtyMyw1TGHkcwwUSEfHu8bwi/n0wjGA1Mymiy+H8oZp55os10//cpbVtNhMeJ0D64f6tpnl7nFnIN5kX35ussvsT5Dzv+vFIKWiOr6N0seWZxZV3JGDz4WR+g9jz+dlKgk6ixx+Lx687nu90tWzUhysa8lYueBns9bKTpz8SRqIfY4i+7QurXNx6+9YG3QsWdz9xf3wu+BSYtPoj42Sy4riA2TECLCBEey4XWZ7CRn926TRg2tVJST3hAybFXuUeMMqSWQ3GAmFO6BQ413xB9/TGORFI+zxD7V9smiOlRSNfCujAWLlphtwrwh8PQfyQxbNMn+ThObPfH4qRbi74ePGS+5wH6zUibpLiDQFcuVs1FLEFLenkdZvnK1jQSDojmiBiGqJ4S2Ts0aVImWiRI8sVR2PUeITuQwk5OopnjpPKIXJvhCoANhzGRknSbvN8F8B4Ny44c2SEpzUn6zeY5d5qkUXuOK/8S3w8OMiS6CgSUrMI6hI0db30ImIjxlHrtOEGTSKWyWG/jzL/KCqMk2uzAMabf0CemdsUFqx3l9/NGNZMyPsbb/ZPdhd/hoCYaJ9CxSE0IMAfYjtRK1wWuvZ8ya7THJSFQi0U7JQmYJK7epT6LMNXIHhBDGinBcv8A0h40Ya1O3z5wz1yAwsX4ga1bjlmcvKZo6c4151LTJkSnnCvPvo9/jI5CUgXz9wyDz+EuvikqY3AEUbNpGCElcPjmi2KPgF16WwzuPI3zLkRS/RvzvSPl1a9YwrzzZPeXdtvFbytlR+kk0FJlZcUIyOWF+NrRVFiWqsk/wctZ6bG2ICztmiXKjsLeByZ9KUEJsS7G/YHqkdeCFU0jO2I0xf7md5rG1c/YLfKz5BKYaWPQ5a2nv1sYkY1NmiG0eooqDFYbh29D3bg/+ndYZCxg6z4ppK+KzKSrj/b/3rEFEMZVulrWDsIeggDbGOGNyDPp/gtfq7/QQSMpAiCHeJkQtnYI6eYCYZOKVv2Qxu6Rz8c4nOkZ01gFiv0al1aIIKAKKgCKwbxFIykDM1i1mz/qV1m6a426K7hvRMrJemVbqbXRpnMqlZQOV2PO1KAKKgCKgCOxbBOKrCBl92jHlF/P3C5JlskDy+OR/5RHEhJW3QnVT5MHeJk+J2Fd7/iv315soAoqAIqAIxCCQlIGInUm2gm6XC0JgMyISRHaua1EEFAFFQBEIBwLJGQh9xOEQBqdDWPoRjnHTXigCioAisM8RcIHo+7wj2gFFQBFQBBSB/QuB7DUQCdNkI9Y+L2Hpxz4HQjugCCgCikA4EEjOQDAbSU5++7ev++v6EgZ/zL7GQu+vCCgCikAIEEgaxrtn41qza8nccPhARAPJU1A27VWvHw6GFoLB0y4oAoqAIrAvEUjKQPZlx/TeioAioAgoAuFGQJ3o4R4f7Z0ioAgoAqFFQBlIaIdGO6YIKAKKQLgRUAYS7vHR3ikCioAiEFoElIGEdmi0Y4qAIqAIhBsBZSDhHh/tnSKgCCgCoUVAGUhoh0Y7pggoAopAuBFQBhLu8dHeKQKKgCIQWgSUgYR2aLRjioAioAiEGwFlIOEeH+2dIqAIKAKhRUAZSGiHRjumCCgCikC4EVAGEu7x0d4pAoqAIhBaBJSBhHZotGOKgCKgCIQbAWUg4R4f7Z0ioAgoAqFFQBlIaIdGO6YIKAKKQLgRUAYS7vHR3ikCioAiEFoElIGEdmi0Y4qAIqAIhBsBZSDhHh/tnSKgCCgCoUVAGUhoh0Y7pggoAopAuBFQBhLu8dHeKQKKgCIQWgSUgYR2aLRjioAioAiEGwFlIOEeH+2dIqAIKAKhRUAZSGiHRjumCCgCikC4EVAGEu7x0d4pAoqAIhBaBJSBhHZotGOKgCKgCIQbAWUg4R4f7Z0ioAgoAqFFQBlIaIdGO6YIKAKKQLgRUAYS7vHR3ikCioAiEFoElIGEdmi0Y4qAIqAIhBsBZSDhHh/tnSKgCCgCoUVAGUhoh0Y7pggoAopAuBFQBhLu8dHeKQKKgCIQWgSUgYR2aLRjioAioAiEGwFlIOEeH+2dIqAIKAKhRUAZSGiHRjumCCgCikC4EVAGEu7x0d4pAoqAIhBaBJSBhHZotGOKgCKgCIQbAWUg4R4f7Z0ioAgoAqFFQBlIaIdGO6YIKAKKQLgRUAYS7vHR3ikCioAiEFoElIGEdmi0Y4qAIqAIhBsBZSDhHh/tnSKgCCgCoUVAGUhoh0Y7pggoAopAuBFQBhLu8dHeKQKKgCIQWgT+D9GP0CLQthgtAAAAAElFTkSuQmCC" width="180" alt="SecureWorks Group" style="display:block;margin-bottom:14px" />
  <p style="margin:0 0 2px;font-size:14px;font-weight:bold;color:#293C46">Marnin Stobbe</p>
  <p style="margin:0 0 10px;font-size:12px;color:#4C6A7C">Operations Manager</p>
  <p style="margin:0 0 10px;font-size:10px;color:#293C46;letter-spacing:1.5px;font-weight:600">EXCELLENCE &nbsp;|&nbsp; INTEGRITY &nbsp;|&nbsp; SERVICE</p>
  <p style="margin:0;font-size:12px;color:#4C6A7C;line-height:20px">
    <b style="color:#293C46">P:</b> <a href="tel:0404777984" style="color:#4C6A7C;text-decoration:none">0404 777 984</a><br/>
    <b style="color:#293C46">E:</b> <a href="mailto:marnin@secureworkswa.com.au" style="color:#F15A29;text-decoration:none">marnin@secureworkswa.com.au</a>
  </p>
</div>`

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

class OutlookFenceError extends Error {
  constructor(
    readonly status: number,
    readonly refusal: {
      state: 'refused'
      fact: string
      code?: string
      recovery_action?: string
      evidence?: Record<string, unknown>
    },
  ) {
    super(String(refusal.fact || refusal.code || 'Outlook SES fence refused'))
  }
}

export class OutlookInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OutlookInputError'
  }
}

export class GraphProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly outcomeUnknown = false,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'GraphProviderError'
  }
}

type FetchLike = typeof fetch

export type OutlookRoute =
  | { kind: 'mailbox'; mailbox: string }
  | { kind: 'group'; group: string; reason: string }

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OutlookInputError(
      'invalid_source',
      `${field} must be a non-empty string`,
    )
  }
  return value.trim()
}

function isEmail(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
}

export function splitRecipientInput(
  value: unknown,
  field: string,
  required = false,
): string[] {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new OutlookInputError(
        'invalid_recipient',
        `${field} must contain at least one recipient`,
      )
    }
    return []
  }
  const values = Array.isArray(value) ? value : [value]
  const output: string[] = []
  for (const entry of values) {
    if (typeof entry !== 'string') {
      throw new OutlookInputError(
        'invalid_recipient',
        `${field} entries must be strings`,
      )
    }
    for (const candidate of entry.split(',')) {
      const email = candidate.trim()
      if (!email || !isEmail(email)) {
        throw new OutlookInputError(
          'invalid_recipient',
          `${field} contains an invalid address`,
        )
      }
      output.push(email)
    }
  }
  if (required && output.length === 0) {
    throw new OutlookInputError(
      'invalid_recipient',
      `${field} must contain at least one recipient`,
    )
  }
  return output
}

function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field)
}

export function classifyOutlookRoute(
  body: Record<string, unknown>,
): OutlookRoute {
  if (
    body.from !== undefined && body.mailbox !== undefined &&
    String(body.from).trim().toLowerCase() !==
      String(body.mailbox).trim().toLowerCase()
  ) {
    throw new OutlookInputError(
      'invalid_source',
      'from and mailbox must identify the same exact mailbox',
    )
  }
  if (body.action === 'forward') {
    const unsupportedSourceFields = [
      'from',
      'group_email',
      'group_id',
      'from_group',
      'target_type',
      'source_type',
    ].filter((field) => hasOwn(body, field))
    if (unsupportedSourceFields.length) {
      throw new OutlookInputError(
        'invalid_source',
        `Forward source contains unsupported fields: ${unsupportedSourceFields.join(', ')}`,
      )
    }
    if (hasOwn(body, 'group')) {
      const group = nonEmptyString(body.group, 'group')
      return { kind: 'group', group, reason: 'forward_group_source' }
    }
    return {
      kind: 'mailbox',
      mailbox: nonEmptyString(body.mailbox, 'mailbox'),
    }
  }
  const targetType = body.target_type ?? body.source_type
  if (
    targetType !== undefined && targetType !== 'mailbox' &&
    targetType !== 'user' && targetType !== 'group'
  ) {
    throw new OutlookInputError(
      'invalid_source',
      'target_type must be mailbox, user, or group',
    )
  }
  if (
    targetType === 'group' || hasOwn(body, 'group') ||
    hasOwn(body, 'group_id') ||
    hasOwn(body, 'from_group') || hasOwn(body, 'group_email')
  ) {
    const group = nonEmptyString(
      body.group ?? body.group_email ?? body.from_group ?? body.from,
      'group',
    )
    return {
      kind: 'group',
      group,
      reason: 'group_sender_requires_group_action',
    }
  }
  const mailbox = nonEmptyString(
    body.from ?? body.mailbox ?? DEFAULT_MAILBOX,
    'from',
  )
  if (KNOWN_GROUP_ADDRESSES.has(mailbox.toLowerCase())) {
    return {
      kind: 'group',
      group: mailbox,
      reason: 'known_group_sender_requires_group_action',
    }
  }
  return { kind: 'mailbox', mailbox }
}

export function assertNoLegacyReplyFields(body: Record<string, unknown>): void {
  const present = LEGACY_REPLY_FIELDS.filter((field) => hasOwn(body, field))
  if (present.length > 0) {
    throw new OutlookInputError(
      'legacy_reply_fields_unsupported',
      `Use action=reply with mailbox and message_id; ignored legacy reply fields are rejected (${
        present.join(', ')
      })`,
    )
  }
}

async function assertOutlookJobAllowed(
  client: any,
  jobId: string,
  action: string,
) {
  try {
    const inspection = await inspectSealedSesJob(client, jobId)
    if (inspection.sealed) {
      throw new OutlookFenceError(
        409,
        sealedSesMoneyRefusal(action, {
          job_id: jobId,
          matched_by: inspection.matched_by,
        }),
      )
    }
  } catch (error) {
    if (error instanceof OutlookFenceError) throw error
    throw new OutlookFenceError(
      503,
      sealedSesFenceCheckFailedRefusal(
        action,
        (error as Error).message,
        { job_id: jobId },
      ),
    )
  }
}

async function resolveOutlookInvoiceJob(
  client: any,
  xeroInvoiceId: string,
): Promise<string | null> {
  const mirror = await client.from('xero_invoices')
    .select(
      'job_id,invoice_type,invoice_obligation_revision_id,ses_external_token',
    )
    .eq('xero_invoice_id', xeroInvoiceId)
    .maybeSingle()
  if (mirror.error) {
    throw new OutlookFenceError(
      503,
      sealedSesFenceCheckFailedRefusal(
        'send_outlook_email',
        `The invoice mirror lookup failed (${mirror.error.message}).`,
        { xero_invoice_id: xeroInvoiceId },
      ),
    )
  }
  if (!mirror.data) {
    throw new OutlookFenceError(
      503,
      sealedSesFenceCheckFailedRefusal(
        'send_outlook_email',
        'The invoice is missing from the local Xero mirror.',
        { xero_invoice_id: xeroInvoiceId },
      ),
    )
  }
  const invoiceType = String(mirror.data.invoice_type || '').toUpperCase()
  if (
    invoiceType !== 'ACCPAY' &&
    (mirror.data.invoice_obligation_revision_id ||
      mirror.data.ses_external_token)
  ) {
    throw new OutlookFenceError(
      409,
      sealedSesMoneyRefusal('send_outlook_email', {
        xero_invoice_id: xeroInvoiceId,
        job_id: mirror.data.job_id || null,
      }),
    )
  }
  if (invoiceType !== 'ACCPAY' && !mirror.data.job_id) {
    throw new OutlookFenceError(
      409,
      invoiceLinkRequiredRefusal('send_outlook_email', {
        xero_invoice_id: xeroInvoiceId,
        invoice_type: invoiceType || null,
      }),
    )
  }
  if (mirror.data.job_id) {
    await assertOutlookJobAllowed(
      client,
      mirror.data.job_id,
      'send_outlook_email',
    )
  }
  return mirror.data.job_id || null
}

/**
 * Sender-only reply fence.
 *
 * A mailbox message with no stored job can still be answered, but only by
 * replying to that message's own stored inbound sender, from the mailbox that
 * received it, with nothing else attached to the send. Every widening — a CC,
 * a reply-all, a second recipient, a recipient override or an attachment — is
 * refused here, before any Graph call. Graph's own reply draft is checked
 * against the same expected_to list in handleReply, so the message can only
 * leave if the stored record and the provider agree on the recipient.
 */
export function assertSenderOnlyReplyAllowed(
  body: Record<string, unknown>,
  source: { message_id: string; mailbox: string; sender: string },
) {
  const refuse = (fact: string, recovery_action: string): never => {
    throw new OutlookFenceError(409, {
      state: 'refused',
      code: 'reply_sender_only_required',
      fact,
      recovery_action,
      evidence: {
        message_id: source.message_id,
        mailbox: source.mailbox,
        stored_sender: source.sender || null,
      },
    })
  }

  const sender = source.sender.toLowerCase()
  if (!sender || !isEmail(sender)) {
    refuse(
      'The source message has no usable stored sender, so a reply with no job has no verified recipient.',
      'Link the message to a job and reply on the job-anchored path.',
    )
  }
  if (KNOWN_GROUP_ADDRESSES.has(sender)) {
    refuse(
      'The stored sender is a Microsoft 365 Group address, not an external correspondent.',
      'Answer group traffic through the supported Group action.',
    )
  }
  if (body.reply_all === true) {
    refuse(
      'A reply with no stored job cannot be a reply-all.',
      'Reply to the original sender only, or supply the job_id that owns this message.',
    )
  }
  for (const field of ['to', 'to_email', 'cc', 'bcc']) {
    if (hasOwn(body, field)) {
      refuse(
        `A native reply never accepts ${field}.`,
        'Remove the recipient override; provider reply routing is preserved.',
      )
    }
  }
  const expectedTo = splitRecipientInput(body.expected_to, 'expected_to', true)
  if (
    expectedTo.length !== 1 || expectedTo[0].trim().toLowerCase() !== sender
  ) {
    refuse(
      'A reply with no stored job may go only to the stored sender of that exact message.',
      'Set expected_to to exactly the stored sender of this message, or supply the job_id.',
    )
  }
  const expectedCc = splitRecipientInput(body.expected_cc, 'expected_cc')
  if (expectedCc.length > 0) {
    refuse(
      'A reply with no stored job cannot carry CC recipients.',
      'Remove every CC recipient, or supply the job_id that owns this message.',
    )
  }
  if (Array.isArray(body.attachments) ? body.attachments.length > 0 : Boolean(body.attachments)) {
    refuse(
      'A reply with no stored job cannot carry attachments; attachment provenance is expressed through the job.',
      'Send the attachment from the job-anchored path once the message is linked to a job.',
    )
  }
}

export async function assertOutlookSesDeliveryAllowed(
  client: any,
  body: Record<string, any>,
) {
  const recipients = Array.isArray(body.to) ? body.to : [body.to]
  const syntheticInboundFixture = body.sent_by === 'ses_synthetic_livefire_lab' &&
    String(body.from || '').toLowerCase() === 'marnin@secureworkswa.com.au' &&
    recipients.length === 1 &&
    String(recipients[0] || '').toLowerCase() === 'ses@secureworkswa.com.au' &&
    !body.action &&
    !body.job_id &&
    !body.xero_invoice_id
  if (syntheticInboundFixture) return

  const bodyJobId = String(body.job_id || '').trim()
  const bodyInvoiceId = String(body.xero_invoice_id || '').trim()

  if (body.action === 'reply') {
    const requestedMailbox = String(body.mailbox || '').trim()
    const mailboxMessageId = String(body.message_id || '').trim()
    // A job_id that is present but blank must refuse outright. Treating it as
    // absent would let a malformed anchor select the sender-only path, which
    // is the one path that does not run the stored-job fence.
    if (hasOwn(body, 'job_id') && body.job_id !== null && !bodyJobId) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact: 'job_id was supplied but is blank, so no job anchor could be resolved.',
        recovery_action:
          'Send the exact job_id stored against this source message, or omit job_id entirely for a sender-only reply.',
        evidence: { message_id: mailboxMessageId || null },
      })
    }
    if (!requestedMailbox || !mailboxMessageId || body.post_id) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'A native mailbox reply requires an exact mailbox and an authoritative source message before replying.',
        recovery_action:
          'Resolve the source message in the stored inbox record, then retry with those exact identities.',
      })
    }
    const source = await client.from('inbox_events')
      .select('job_id,mailbox,from_email')
      .eq('graph_message_id', mailboxMessageId)
      .maybeSingle()
    if (source.error) {
      throw new OutlookFenceError(
        503,
        sealedSesFenceCheckFailedRefusal(
          'reply_outlook_email',
          `The source-message job lookup failed (${source.error.message}).`,
          { message_id: mailboxMessageId },
        ),
      )
    }
    const sourceJobId = String(source.data?.job_id || '').trim()
    const sourceMailbox = String(source.data?.mailbox || '').trim()
    const sourceSender = String(source.data?.from_email || '').trim()
    // The mailbox that received the message is the only mailbox allowed to
    // answer it, on both the job-anchored and the sender-only path. An
    // unknown source message can never be replied to at all.
    if (
      !source.data || !sourceMailbox ||
      sourceMailbox.toLowerCase() !== requestedMailbox.toLowerCase()
    ) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'The reply source message is not authoritatively stored against the requested mailbox.',
        recovery_action:
          'Reply only from the mailbox that received the message, using the stored source identity.',
        evidence: {
          message_id: mailboxMessageId,
          requested_mailbox: requestedMailbox,
          stored_mailbox: sourceMailbox || null,
        },
      })
    }
    if (bodyJobId) {
      if (!sourceJobId || sourceJobId !== bodyJobId) {
        throw new OutlookFenceError(409, {
          state: 'refused',
          code: 'pdf_provenance_required',
          fact:
            'The reply source message is not authoritatively linked to the supplied job_id.',
          recovery_action:
            'Use the source message and job identities stored together; never use a decoy job.',
          evidence: {
            message_id: mailboxMessageId,
            requested_mailbox: requestedMailbox,
            stored_mailbox: sourceMailbox,
            stored_job_id: sourceJobId || null,
            received_job_id: bodyJobId,
          },
        })
      }
      await assertOutlookJobAllowed(client, sourceJobId, 'reply_outlook_email')
      return
    }
    // No job supplied. This is only allowed for a message that genuinely has
    // no stored job, and only as a reply to that message's own stored sender.
    if (sourceJobId) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'The reply source message has a stored job, so the reply must name that job_id.',
        recovery_action:
          'Retry with the job_id stored against this source message.',
        evidence: {
          message_id: mailboxMessageId,
          requested_mailbox: requestedMailbox,
          stored_job_id: sourceJobId,
          received_job_id: null,
        },
      })
    }
    assertSenderOnlyReplyAllowed(body, {
      message_id: mailboxMessageId,
      mailbox: requestedMailbox,
      sender: sourceSender,
    })
    return
  }

  if (body.action === 'forward') {
    const mailboxMessageId = String(body.message_id || '').trim()
    const groupPostId = String(body.post_id || '').trim()
    const requestedMailbox = String(body.mailbox || '').trim()
    const requestedGroup = String(body.group || '').trim()
    if (!bodyJobId || (!mailboxMessageId && !groupPostId)) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact:
          'Graph forwarding preserves opaque attachments, so an authoritative source message and job_id are required before forwarding.',
        recovery_action:
          'Resolve the source message to its stored job, then retry with those exact identities.',
      })
    }
    const source = mailboxMessageId
      ? await client.from('inbox_events')
        .select('job_id,mailbox')
        .eq('graph_message_id', mailboxMessageId)
        .maybeSingle()
      : await client.from('makesafe_intake_drafts')
        .select('approved_job_id,mailbox')
        .eq('graph_message_id', groupPostId)
        .maybeSingle()
    if (source.error) {
      throw new OutlookFenceError(
        503,
        sealedSesFenceCheckFailedRefusal(
          'forward_outlook_email',
          `The source-message job lookup failed (${source.error.message}).`,
          {
            message_id: mailboxMessageId || null,
            post_id: groupPostId || null,
          },
        ),
      )
    }
    const sourceJobId = String(
      source.data?.job_id || source.data?.approved_job_id || '',
    ).trim()
    const sourceMailbox = String(source.data?.mailbox || '').trim()
    const requestedSource = mailboxMessageId ? requestedMailbox : requestedGroup
    if (
      !sourceJobId || sourceJobId !== bodyJobId ||
      !sourceMailbox || !requestedSource ||
      sourceMailbox.toLowerCase() !== requestedSource.toLowerCase()
    ) {
      throw new OutlookFenceError(409, {
        state: 'refused',
        code: 'pdf_provenance_required',
        fact: 'The forwarded source message is not authoritatively linked to the supplied job_id.',
        recovery_action:
          'Use the source message and job identities stored together; never use a decoy job.',
        evidence: {
          message_id: mailboxMessageId || null,
          post_id: groupPostId || null,
          requested_mailbox_or_group: requestedSource || null,
          stored_mailbox: sourceMailbox || null,
          stored_job_id: sourceJobId || null,
          received_job_id: bodyJobId,
        },
      })
    }
    await assertOutlookJobAllowed(client, sourceJobId, 'forward_outlook_email')
    return
  }

  let invoiceJobId: string | null = null
  if (bodyInvoiceId) {
    invoiceJobId = await resolveOutlookInvoiceJob(client, bodyInvoiceId)
  }
  if (bodyJobId) {
    if (invoiceJobId && invoiceJobId !== bodyJobId) {
      throw new OutlookFenceError(
        409,
        invoiceLinkRequiredRefusal(
          'send_outlook_email',
          {
            xero_invoice_id: bodyInvoiceId,
            expected_job_id: invoiceJobId,
            received_job_id: bodyJobId,
          },
        ),
      )
    }
    await assertOutlookJobAllowed(client, bodyJobId, 'send_outlook_email')
  }

  for (
    const attachment of Array.isArray(body.attachments) ? body.attachments : []
  ) {
    const contentBytes = String(attachment?.contentBytes || '').trim()
    const isPdf = String(attachment?.contentType || '').toLowerCase() ===
        'application/pdf' ||
      /\.pdf(?:$|[?#])/i.test(
        String(attachment?.name || attachment?.url || ''),
      ) ||
      contentBytes.startsWith('JVBERi0')
    if (!isPdf) continue

    const attachmentInvoiceId = String(
      attachment?.xero_invoice_id || bodyInvoiceId || '',
    ).trim()
    if (attachmentInvoiceId) {
      const attachmentJobId = attachmentInvoiceId === bodyInvoiceId
        ? invoiceJobId
        : await resolveOutlookInvoiceJob(client, attachmentInvoiceId)
      if (bodyJobId && attachmentJobId && bodyJobId !== attachmentJobId) {
        throw new OutlookFenceError(
          409,
          invoiceLinkRequiredRefusal(
            'send_outlook_email',
            {
              xero_invoice_id: attachmentInvoiceId,
              expected_job_id: attachmentJobId,
              received_job_id: bodyJobId,
            },
          ),
        )
      }
      continue
    }

    const jobDocumentId = String(
      attachment?.job_document_id || body.job_document_id || '',
    ).trim()
    if (jobDocumentId) {
      const document = await client.from('job_documents')
        .select('id,job_id')
        .eq('id', jobDocumentId)
        .maybeSingle()
      if (document.error || !document.data?.job_id) {
        throw new OutlookFenceError(
          document.error ? 503 : 409,
          sealedSesFenceCheckFailedRefusal(
            'send_outlook_email',
            document.error
              ? `The job document lookup failed (${document.error.message}).`
              : 'The job document is missing or has no job link.',
            { job_document_id: jobDocumentId },
          ),
        )
      }
      if (bodyJobId && bodyJobId !== document.data.job_id) {
        throw new OutlookFenceError(409, {
          state: 'refused',
          code: 'pdf_provenance_required',
          fact: 'The PDF job_document_id does not belong to the supplied job_id.',
          recovery_action: 'Use the document and job identities stored together.',
        })
      }
      await assertOutlookJobAllowed(
        client,
        document.data.job_id,
        'send_outlook_email',
      )
      continue
    }

    throw new OutlookFenceError(409, {
      state: 'refused',
      code: 'pdf_provenance_required',
      fact:
        'A PDF attachment requires an authoritative xero_invoice_id or job_document_id before Graph delivery.',
      recovery_action:
        'Attach the invoice or job-document identity that owns this PDF, then retry.',
    })
  }
}

// ── Graph OAuth2 Token ──

let _cachedToken: { token: string; expires: number } | null = null

function tokenExpiryClaim(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
    const claims = JSON.parse(atob(padded)) as { exp?: unknown }
    if (claims.exp === undefined) return null
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
      throw new Error('token exp claim is invalid')
    }
    return claims.exp * 1000
  } catch (error) {
    if (
      error instanceof Error && error.message === 'token exp claim is invalid'
    ) throw error
    return null
  }
}

function validateToken(
  data: Record<string, unknown>,
): { token: string; expires: number } {
  const token = typeof data.access_token === 'string' ? data.access_token.trim() : ''
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in)
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(
      'Graph token response has no valid access_token/expires_in',
    )
  }
  const now = Date.now()
  const advertisedExpiry = now + expiresIn * 1000
  const claimedExpiry = tokenExpiryClaim(token)
  const expires = claimedExpiry === null
    ? advertisedExpiry
    : Math.min(advertisedExpiry, claimedExpiry)
  if (!Number.isFinite(expires) || expires <= now) {
    throw new Error('Graph token is already expired')
  }
  return { token, expires }
}

export function resetGraphTokenCache(): void {
  _cachedToken = null
}

export async function getGraphToken(options: {
  forceRefresh?: boolean
  fetchImpl?: FetchLike
} = {}): Promise<string> {
  const fetchImpl = options.fetchImpl || fetch
  if (
    !options.forceRefresh && _cachedToken &&
    _cachedToken.expires > Date.now() + 300000
  ) {
    return _cachedToken.token
  }

  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID')
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID')
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET')

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET must be set',
    )
  }

  const resp = await fetchWithTimeout(
    fetchImpl,
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    },
    GRAPH_TIMEOUT_MS,
  )

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Graph token request failed: ${resp.status} ${err}`)
  }

  _cachedToken = validateToken(await resp.json() as Record<string, unknown>)
  return _cachedToken.token
}

type GraphRequestOptions = {
  fetchImpl?: FetchLike
  timeoutMs?: number
  mutating?: boolean
}

function isMutationMethod(method: string | undefined): boolean {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(
    (method || 'GET').toUpperCase(),
  )
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function graphRequest(
  path: string,
  init: RequestInit = {},
  options: GraphRequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = options.timeoutMs || GRAPH_TIMEOUT_MS
  const mutating = options.mutating ?? isMutationMethod(init.method)
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`
  const body = init.body
  let token = await getGraphToken({ fetchImpl })
  const request = () =>
    fetchWithTimeout(fetchImpl, url, {
      ...init,
      body,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    }, timeoutMs)

  let response: Response
  try {
    response = await request()
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Graph request failed: ${(error as Error).message}`,
      mutating,
    )
  }

  if (response.status === 401) {
    let refreshedToken: string
    try {
      refreshedToken = await getGraphToken({ forceRefresh: true, fetchImpl })
    } catch (error) {
      throw new GraphProviderError(
        401,
        `Graph request was rejected and token refresh failed: ${(error as Error).message}`,
        false,
        { token_refreshed: false, retry_safe: false },
      )
    }
    if (mutating) {
      // A 401 may arrive after Graph accepted a mutation. Refresh the cache for
      // a later read/reconciliation, but never replay the business write.
      throw new GraphProviderError(
        401,
        'Graph rejected a mutating request after token refresh; the request was not replayed',
        false,
        { token_refreshed: true, retry_safe: false },
      )
    }
    token = refreshedToken
    try {
      response = await request()
    } catch (error) {
      throw new GraphProviderError(
        0,
        `Graph refresh request failed: ${(error as Error).message}`,
        mutating,
      )
    }
  }

  if (!response.ok) {
    const detail = (await response.clone().text()).slice(0, 2000)
    const unknown = mutating &&
      (response.status >= 500 || response.status === 408 ||
        response.status === 429)
    throw new GraphProviderError(
      response.status,
      `Graph request failed: ${response.status}${detail ? ` ${detail}` : ''}`,
      unknown,
      unknown ? { retry_safe: false } : {},
    )
  }
  return response
}

// ── Download + Base64 encode attachment from URL ──

type GraphFileAttachment = {
  '@odata.type': string
  name: string
  contentType: string
  contentBytes: string
}

function allowedAttachmentHost(
  hostname: string,
  extraHosts: string[] = [],
): boolean {
  const host = hostname.toLowerCase()
  let supabaseHost = ''
  try {
    supabaseHost = new URL(SUPABASE_URL || '').hostname.toLowerCase()
  } catch (_) {
    // Test and local environments may not define SUPABASE_URL.
  }
  if (supabaseHost && host === supabaseHost) return true
  return extraHosts.map((item) => item.toLowerCase()).includes(host)
}

async function readAttachmentBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length') || '')
  if (
    Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES
  ) {
    throw new OutlookInputError(
      'attachment_too_large',
      `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
    )
  }
  if (!response.body) {
    throw new OutlookInputError(
      'attachment_invalid_response',
      'Attachment response did not expose a bounded body stream',
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value)
      total += chunk.length
      if (total > MAX_ATTACHMENT_BYTES) {
        await reader.cancel()
        throw new OutlookInputError(
          'attachment_too_large',
          `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
        )
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(start, Math.min(start + chunkSize, bytes.length)),
    )
  }
  return btoa(binary)
}

export async function fetchAttachment(url: string, name: string, options: {
  fetchImpl?: FetchLike
  timeoutMs?: number
  allowedHosts?: string[]
} = {}): Promise<GraphFileAttachment> {
  if (typeof url !== 'string' || !url.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      'Attachment URL is required',
    )
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      'Attachment name is required',
    )
  }
  const fetchImpl = options.fetchImpl || fetch
  const allowedHosts = [
    ...(options.allowedHosts || []),
    ...(Deno.env.get('OUTLOOK_ATTACHMENT_HOSTS') || '').split(',').map((item) => item.trim())
      .filter(Boolean),
  ]
  let current = url.trim()
  for (let redirect = 0; redirect <= MAX_ATTACHMENT_REDIRECTS; redirect++) {
    const parsed = new URL(current)
    if (
      parsed.protocol !== 'https:' ||
      !allowedAttachmentHost(parsed.hostname, allowedHosts)
    ) {
      throw new OutlookInputError(
        'attachment_source_not_allowed',
        'Attachment URL must use approved HTTPS storage',
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs || GRAPH_TIMEOUT_MS,
    )
    let resp: Response
    try {
      resp = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      throw new OutlookInputError(
        'attachment_download_failed',
        `Failed to download attachment: ${(error as Error).message}`,
      )
    } finally {
      clearTimeout(timer)
    }
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location || redirect === MAX_ATTACHMENT_REDIRECTS) {
        throw new OutlookInputError(
          'attachment_redirect_limit',
          'Attachment redirect limit exceeded',
        )
      }
      current = new URL(location, current).toString()
      continue
    }
    if (!resp.ok) {
      throw new OutlookInputError(
        'attachment_download_failed',
        `Failed to download attachment (${resp.status})`,
      )
    }
    const bytes = await readAttachmentBytes(resp)
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const contentTypes: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv',
    }
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: name.trim(),
      contentType: contentTypes[ext] || 'application/octet-stream',
      contentBytes: encodeBase64(bytes),
    }
  }
  throw new OutlookInputError(
    'attachment_redirect_limit',
    'Attachment redirect limit exceeded',
  )
}

export function validateInlineAttachment(
  att: Record<string, unknown>,
): GraphFileAttachment {
  if (typeof att.name !== 'string' || !att.name.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      'Attachment name is required',
    )
  }
  if (typeof att.contentBytes !== 'string' || !att.contentBytes.trim()) {
    throw new OutlookInputError(
      'invalid_attachment',
      `Attachment ${att.name} has no contentBytes`,
    )
  }
  const contentBytes = att.contentBytes.trim()
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBytes) ||
    contentBytes.length % 4 !== 0
  ) {
    throw new OutlookInputError(
      'invalid_attachment',
      `Attachment ${att.name} has invalid base64 content`,
    )
  }
  let decoded: string
  try {
    decoded = atob(contentBytes)
  } catch (_) {
    throw new OutlookInputError(
      'invalid_attachment',
      `Attachment ${att.name} has invalid base64 content`,
    )
  }
  if (decoded.length > MAX_ATTACHMENT_BYTES) {
    throw new OutlookInputError(
      'attachment_too_large',
      `Attachment ${att.name} exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
    )
  }
  const contentType = typeof att.contentType === 'string' && att.contentType.trim()
    ? att.contentType.trim()
    : 'application/octet-stream'
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: att.name.trim(),
    contentType,
    contentBytes,
  }
}

export async function prepareAttachments(attachments: unknown, options: {
  fetchImpl?: FetchLike
  timeoutMs?: number
  allowedHosts?: string[]
} = {}): Promise<GraphFileAttachment[]> {
  if (attachments === undefined || attachments === null) return []
  if (!Array.isArray(attachments)) {
    throw new OutlookInputError(
      'invalid_attachment',
      'attachments must be an array',
    )
  }
  const result: GraphFileAttachment[] = []
  let encodedTotal = 0
  for (const raw of attachments) {
    if (!raw || typeof raw !== 'object') {
      throw new OutlookInputError(
        'invalid_attachment',
        'Every attachment must be an object',
      )
    }
    const att = raw as Record<string, unknown>
    let prepared: GraphFileAttachment
    if (att.url !== undefined) {
      if (
        typeof att.url !== 'string' || typeof att.name !== 'string' ||
        !att.name.trim()
      ) {
        throw new OutlookInputError(
          'invalid_attachment',
          'URL attachments require url and name',
        )
      }
      prepared = await fetchAttachment(att.url, att.name, options)
    } else {
      prepared = validateInlineAttachment(att)
    }
    encodedTotal += prepared.contentBytes.length
    if (encodedTotal > MAX_MESSAGE_BYTES) {
      throw new OutlookInputError(
        'message_too_large',
        'Encoded attachments exceed message limit',
      )
    }
    result.push(prepared)
  }
  return result
}

// ── Dynamic Signature Selection ──
export function getSignature(from: string): string {
  const email = (from || '').toLowerCase()
  if (email === 'admin@secureworkswa.com.au' || email === 'admin') {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'Maverick')
      .replace('Operations Manager', 'Operations Assist')
      .replace(
        /<b style="color:#293C46">P:<\/b>[\s\S]*?<br\/>\s*/,
        '',
      )
      .replace(
        /<b style="color:#293C46">E:<\/b>[\s\S]*?<\/a>/,
        '<b style="color:#293C46">E:</b> <a href="mailto:ses@secureworkswa.com.au" style="color:#F15A29;text-decoration:none">ses@secureworkswa.com.au</a><br/><b style="color:#293C46">W:</b> <a href="https://secureworksgroup.com.au" style="color:#4C6A7C;text-decoration:none">secureworksgroup.com.au</a>',
      )
  }
  if (email === 'shaun@secureworkswa.com.au') {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'Shaun')
      .replace('Operations Manager', 'Operations Manager')
      .replace('0404 777 984', '')
      .replace('marnin@secureworkswa.com.au', 'shaun@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:shaun@')
      .replace('tel:0404777984', '')
  }
  if (email === 'jan@secureworkswa.com.au') {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'Jan Stobbe')
      .replace('Operations Manager', 'Director')
      .replace('0404 777 984', '')
      .replace('marnin@secureworkswa.com.au', 'jan@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:jan@')
      .replace('tel:0404777984', '')
  }
  if (email === 'fencing@secureworkswa.com.au') {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'SecureWorks Fencing')
      .replace('Operations Manager', 'Fencing Division')
      .replace('0404 777 984', '08 6102 2796')
      .replace('marnin@secureworkswa.com.au', 'fencing@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:fencing@')
      .replace('tel:0404777984', 'tel:0861022796')
  }
  if (email === 'patios@secureworkswa.com.au') {
    return EMAIL_SIGNATURE
      .replace('Marnin Stobbe', 'SecureWorks Patios')
      .replace('Operations Manager', 'Patios Division')
      .replace('0404 777 984', '08 6102 2796')
      .replace('marnin@secureworkswa.com.au', 'patios@secureworkswa.com.au')
      .replace('mailto:marnin@', 'mailto:patios@')
      .replace('tel:0404777984', 'tel:0861022796')
  }
  if (email === 'marnin@secureworkswa.com.au') return EMAIL_SIGNATURE
  // A verified mailbox without a mapped legacy signature must not be given
  // another person's identity. The reviewed body remains authoritative.
  return ''
}

// ── Group resolution (M365 Group email -> group ID) ──

const _groupIdCache = new Map<string, string>()

// A caller-supplied address is not enough to select the Graph /users route:
// several directory objects have mail addresses. This read proves that the
// exact target exposes an Exchange mailbox before any provider mutation.
export async function verifyMailboxRoute(mailbox: string): Promise<void> {
  if (!isEmail(mailbox)) {
    throw new OutlookInputError(
      'invalid_source',
      'mailbox must be a valid mailbox address',
    )
  }
  await graphRequest(
    `/users/${safeSegment(mailbox, 'mailbox')}/mailFolders/inbox?$select=id`,
    {},
    { mutating: false },
  )
}

async function resolveGroupId(groupEmail: string): Promise<string> {
  if (!isEmail(groupEmail)) {
    throw new OutlookInputError(
      'invalid_source',
      'group must be a valid group email',
    )
  }
  const cacheKey = groupEmail.toLowerCase()
  const cached = _groupIdCache.get(cacheKey)
  if (cached) return cached

  const resp = await graphRequest(
    `/groups?$filter=${encodeURIComponent(`mail eq '${groupEmail}'`)}&$select=id,mail&$top=2`,
  )
  const data = await resp.json()
  const groups = data.value || []
  if (groups.length === 0) {
    throw new Error(`No M365 Group found for email: ${groupEmail}`)
  }
  if (groups.length > 1) {
    throw new OutlookInputError(
      'ambiguous_source',
      `More than one M365 Group found for email: ${groupEmail}`,
    )
  }

  const groupId = nonEmptyString(groups[0].id, 'group id')
  _groupIdCache.set(cacheKey, groupId)
  return groupId
}

// ── Forward Handler ──
//
// Two source shapes, matching the two mailbox types this system reads from:
//
//  1. Regular user mailbox message (mailbox + message_id):
//     createForward -> optional PATCH ccRecipients -> send. Full fidelity —
//     Graph auto-carries the original body + attachments into the draft, and
//     this path supports cc (a plain `forward` action does not).
//
//  2. M365 Group conversation post (group + thread_id + post_id):
//     Groups don't expose createForward on posts, so this uses the direct
//     `forward` action instead. Graph still auto-carries body + attachments,
//     but there is no cc step for this path — fold any cc addresses into
//     `to` when forwarding from a group.
//
const AUDIT_WARNINGS = [
  'provider_accepted_delivery_unproven',
  'audit_persistence_best_effort',
  'dedupe_or_exact_once_not_available',
]
const DRAFT_WARNINGS = [
  'draft_not_sent',
  'audit_persistence_best_effort',
  'draft_deduplication_unavailable',
]

function safeSegment(value: unknown, field: string): string {
  return encodeURIComponent(nonEmptyString(value, field))
}

function acceptedResponse(
  data: Record<string, unknown>,
  outcome = 'accepted_not_delivered',
  warnings = AUDIT_WARNINGS,
): Response {
  return json({
    ...data,
    accepted: true,
    delivered: null,
    delivery_status: 'unverified',
    outcome,
    retry_safe: false,
    audit_warnings: warnings,
  }, 202)
}

async function sendDraftById(mailbox: string, draftId: string): Promise<void> {
  await graphRequest(
    `/users/${safeSegment(mailbox, 'mailbox')}/messages/${safeSegment(draftId, 'draft_id')}/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { mutating: true },
  )
}

async function addDraftAttachments(
  mailbox: string,
  draftId: string,
  attachments: GraphFileAttachment[],
): Promise<void> {
  // Graph's message attachment endpoint accepts each direct file attachment
  // below 3 MiB. Validate all bytes before createReply/createReplyAll, then
  // add them one by one to the already-created native draft.
  for (const attachment of attachments) {
    await graphRequest(
      `/users/${safeSegment(mailbox, 'mailbox')}/messages/${safeSegment(draftId, 'draft_id')}/attachments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attachment),
      },
      { mutating: true },
    )
  }
}

function messageContent(
  body: Record<string, unknown>,
  mailbox: string,
): Record<string, unknown> {
  const htmlBody = nonEmptyString(body.htmlBody, 'htmlBody')
  const subject = nonEmptyString(body.subject, 'subject')
  const to = splitRecipientInput(body.to, 'to', true)
  const cc = splitRecipientInput(body.cc, 'cc')
  const bcc = splitRecipientInput(body.bcc, 'bcc')
  const message: Record<string, unknown> = {
    subject,
    body: {
      contentType: 'HTML',
      content: htmlBody +
        (/<!--\s*suppress-auto-appended-default-signature\s*-->/i.test(htmlBody)
          ? ''
          : getSignature(mailbox)),
    },
    toRecipients: to.map((email) => ({ emailAddress: { address: email } })),
  }
  if (cc.length) {
    message.ccRecipients = cc.map((email) => ({
      emailAddress: { address: email },
    }))
  }
  if (bcc.length) {
    message.bccRecipients = bcc.map((email) => ({
      emailAddress: { address: email },
    }))
  }
  return message
}

async function handleForward(body: Record<string, unknown>): Promise<Response> {
  const to = splitRecipientInput(body.to_email, 'to_email', true)
  const cc = splitRecipientInput(body.cc, 'cc')
  const toRecipients = to.map((email) => ({
    emailAddress: { address: email },
  }))
  const hasGroupFields = ['group', 'thread_id', 'post_id'].some((field) => hasOwn(body, field))
  const hasMailboxFields = ['mailbox', 'message_id'].some((field) => hasOwn(body, field))
  if (hasGroupFields && hasMailboxFields) {
    throw new OutlookInputError(
      'invalid_source',
      'Forward source must be either a mailbox message or a group post',
    )
  }
  const comment = typeof body.comment === 'string' ? body.comment : ''
  const jobId = typeof body.job_id === 'string' ? body.job_id : null
  let sourceType: 'mailbox' | 'group'
  let subject = '(forwarded email)'
  let fromAddress: string
  let messageId: string | null = null
  let postId: string | null = null

  if (hasGroupFields) {
    const group = nonEmptyString(body.group, 'group')
    const threadId = nonEmptyString(body.thread_id, 'thread_id')
    postId = nonEmptyString(body.post_id, 'post_id')
    sourceType = 'group'
    fromAddress = group
    const allRecipients = [
      ...toRecipients,
      ...cc.map((email) => ({ emailAddress: { address: email } })),
    ]
    const groupId = await resolveGroupId(group)
    await graphRequest(
      `/groups/${safeSegment(groupId, 'group id')}/threads/${
        safeSegment(threadId, 'thread_id')
      }/posts/${safeSegment(postId, 'post_id')}/forward`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment, toRecipients: allRecipients }),
      },
      { mutating: true },
    )
  } else {
    messageId = nonEmptyString(body.message_id, 'message_id')
    const mailbox = nonEmptyString(body.mailbox, 'mailbox')
    sourceType = 'mailbox'
    fromAddress = mailbox
    const createResp = await graphRequest(
      `/users/${safeSegment(mailbox, 'mailbox')}/messages/${
        safeSegment(messageId, 'message_id')
      }/createForward`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toRecipients, comment }),
      },
      { mutating: true },
    )
    let draft: Record<string, unknown>
    try {
      draft = await createResp.json() as Record<string, unknown>
    } catch (error) {
      throw new GraphProviderError(
        0,
        `Forward draft response could not be decoded: ${(error as Error).message}`,
        true,
      )
    }
    let draftId: string
    try {
      draftId = nonEmptyString(draft.id, 'draft_id')
    } catch (error) {
      throw new GraphProviderError(
        0,
        `Forward draft response had no draft_id: ${(error as Error).message}`,
        true,
      )
    }
    try {
      subject = typeof draft.subject === 'string' && draft.subject ? draft.subject : subject
      if (cc.length) {
        await graphRequest(
          `/users/${safeSegment(mailbox, 'mailbox')}/messages/${safeSegment(draftId, 'draft_id')}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ccRecipients: cc.map((email) => ({
                emailAddress: { address: email },
              })),
            }),
          },
          { mutating: true },
        )
      }
      await sendDraftById(mailbox, draftId)
    } catch (error) {
      if (error instanceof GraphProviderError) {
        throw new GraphProviderError(error.status, error.message, true, {
          draft_id: draftId,
        })
      }
      throw new GraphProviderError(
        0,
        `Forward draft ${draftId} was created but not sent: ${(error as Error).message}`,
        true,
        { draft_id: draftId },
      )
    }
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const toStr = [...to, ...cc].join(', ')
  if (jobId) {
    Promise.resolve(
      sb.from('po_communications').insert({
        job_id: jobId,
        direction: 'outbound',
        from_email: fromAddress,
        to_email: toStr,
        cc_emails: cc.length ? cc : null,
        subject,
        body_html: comment,
        communication_type: 'internal_forward',
        sent_at: new Date().toISOString(),
        created_by: body.sent_by || null,
      }),
    ).catch((e: any) => console.log('[send-outlook-email] po_comms log failed:', e?.message))
  }
  Promise.resolve(
    sb.from('email_events').insert({
      email_type: 'forward',
      entity_type: jobId ? 'job' : 'message',
      entity_id: jobId || messageId || postId,
      job_id: jobId,
      recipient: to[0],
      sender: fromAddress,
      subject,
      status: 'accepted',
      sent_at: new Date().toISOString(),
    }),
  ).catch(() => {})
  const warnings = sourceType === 'group'
    ? [...AUDIT_WARNINGS, 'group_requested_source_actual_sender_unverified']
    : AUDIT_WARNINGS
  return acceptedResponse(
    {
      success: true,
      action: 'forward',
      sourceType,
      from: fromAddress,
      ...(sourceType === 'group' ? { requested_source: fromAddress, actual_sender: null } : {}),
      to,
      cc,
      subject,
    },
    'accepted_not_delivered',
    warnings,
  )
}

export async function handleReply(
  body: Record<string, unknown>,
): Promise<Response> {
  assertNoLegacyReplyFields(body)
  if (body.content_reviewed !== true) {
    throw new OutlookInputError(
      'review_required',
      'Reply requires content_reviewed:true',
    )
  }
  if (hasOwn(body, 'to') || hasOwn(body, 'cc') || hasOwn(body, 'bcc')) {
    throw new OutlookInputError(
      'reply_recipient_override',
      'Native replies preserve provider recipients; recipient overrides are not accepted',
    )
  }
  if (body.reply_all !== undefined && typeof body.reply_all !== 'boolean') {
    throw new OutlookInputError('invalid_source', 'reply_all must be boolean')
  }
  const mailbox = nonEmptyString(body.mailbox, 'mailbox')
  const messageId = nonEmptyString(body.message_id, 'message_id')
  const htmlBody = nonEmptyString(body.htmlBody, 'htmlBody')
  if (!Array.isArray(body.expected_to) || !Array.isArray(body.expected_cc)) {
    throw new OutlookInputError(
      'reply_recipients_required',
      'Native replies require explicit expected_to and expected_cc recipient lists',
    )
  }
  const expectedTo = splitRecipientInput(body.expected_to, 'expected_to', true)
  const expectedCc = splitRecipientInput(body.expected_cc, 'expected_cc')
  const attachments = await prepareAttachments(body.attachments)
  const endpoint = body.reply_all ? 'createReplyAll' : 'createReply'
  const createResp = await graphRequest(
    `/users/${safeSegment(mailbox, 'mailbox')}/messages/${
      safeSegment(messageId, 'message_id')
    }/${endpoint}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Do not provide to/cc/bcc/replyTo: Graph carries the original provider
      // recipients and reply metadata into this native draft.
      body: JSON.stringify({
        message: {
          body: {
            contentType: 'HTML',
            content: htmlBody +
              (/<!--\s*suppress-auto-appended-default-signature\s*-->/i.test(
                  htmlBody,
                )
                ? ''
                : getSignature(mailbox)),
          },
        },
      }),
    },
    { mutating: true },
  )
  let draft: Record<string, unknown>
  try {
    draft = await createResp.json() as Record<string, unknown>
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Reply draft response could not be decoded: ${(error as Error).message}`,
      true,
    )
  }
  let draftId: string
  try {
    draftId = nonEmptyString(draft.id, 'draft_id')
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Reply draft response had no draft_id: ${(error as Error).message}`,
      true,
    )
  }
  try {
    const addresses = (value: unknown): string[] => {
      if (!Array.isArray(value)) return []
      return value.map((entry) =>
        String(
          (entry as Record<string, unknown>)?.emailAddress &&
              ((entry as Record<string, any>).emailAddress as Record<
                string,
                unknown
              >).address || '',
        ).trim().toLowerCase()
      ).filter(Boolean)
    }
    const actualTo = addresses(draft.toRecipients)
    const actualCc = addresses(draft.ccRecipients)
    const sameRecipients = (left: string[], right: string[]) => {
      const a = [...left].sort()
      const b = [...right].sort()
      return a.length === b.length &&
        a.every((address, index) => address === b[index])
    }
    if (
      !sameRecipients(
        actualTo,
        expectedTo.map((address) => address.toLowerCase()),
      ) ||
      !sameRecipients(
        actualCc,
        expectedCc.map((address) => address.toLowerCase()),
      )
    ) {
      throw new OutlookInputError(
        'reply_recipient_mismatch',
        'Graph reply draft recipients did not match the reviewed expected recipients',
      )
    }
    if (attachments.length) {
      await addDraftAttachments(mailbox, draftId, attachments)
    }
    await sendDraftById(mailbox, draftId)
  } catch (error) {
    if (error instanceof GraphProviderError) {
      throw new GraphProviderError(error.status, error.message, true, {
        draft_id: draftId,
      })
    }
    throw new GraphProviderError(
      0,
      `Reply draft ${draftId} was created but not sent: ${(error as Error).message}`,
      true,
      { draft_id: draftId },
    )
  }
  return acceptedResponse({
    success: true,
    action: 'reply',
    mailbox,
    message_id: messageId,
    draft_id: draftId,
    reply_all: Boolean(body.reply_all),
    attachments: attachments.length,
  })
}

export async function handleDraft(
  body: Record<string, unknown>,
): Promise<Response> {
  if (body.content_reviewed !== true) {
    throw new OutlookInputError(
      'review_required',
      'Draft creation requires content_reviewed:true',
    )
  }
  const route = classifyOutlookRoute(body)
  if (route.kind !== 'mailbox') {
    throw new OutlookInputError(
      'group_route_required',
      'Drafts require an exact mailbox; group sources are not supported',
    )
  }
  const message = messageContent(body, route.mailbox)
  const attachments = await prepareAttachments(body.attachments)
  if (attachments.length) message.attachments = attachments
  const response = await graphRequest(
    `/users/${safeSegment(route.mailbox, 'mailbox')}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    },
    { mutating: true },
  )
  let draft: Record<string, unknown>
  try {
    draft = await response.json() as Record<string, unknown>
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Graph draft response could not be decoded: ${(error as Error).message}`,
      true,
    )
  }
  let draftId: string
  try {
    draftId = nonEmptyString(draft.id, 'draft_id')
  } catch (error) {
    throw new GraphProviderError(
      0,
      `Graph draft response had no draft_id: ${(error as Error).message}`,
      true,
    )
  }
  const changeKey = typeof draft.changeKey === 'string' ? draft.changeKey : null
  return acceptedResponse(
    {
      success: true,
      action: 'draft',
      mailbox: route.mailbox,
      draft_id: draftId,
      changeKey,
      change_key: changeKey,
      attachments: attachments.length,
      sent: false,
      isDraft: true,
    },
    'draft_created_not_sent',
    DRAFT_WARNINGS,
  )
}

// ── Main Handler ──

export async function handleOutlookRequest(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

    // Auth — same pattern as ghl-proxy
    const validKey = Deno.env.get('SW_API_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const xApiKey = req.headers.get('x-api-key')
    const authHeader = req.headers.get('authorization')
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const suppliedCredential = xApiKey || bearerToken
    const opsAgentKey = Deno.env.get('OPS_AGENT_SERVER_KEY')

    if (xApiKey && bearerToken && xApiKey !== bearerToken) {
      return json({ error: 'Conflicting credentials' }, 401)
    }
    const opsAuthorized = Boolean(
      suppliedCredential && (
        (serviceKey && serviceKey !== validKey && suppliedCredential === serviceKey) ||
        (opsAgentKey && opsAgentKey !== validKey &&
          suppliedCredential === opsAgentKey)
      ),
    )
    const isAuthed = opsAuthorized || Boolean(validKey && suppliedCredential === validKey)
    if (!isAuthed) return json({ error: 'Unauthorized' }, 401)

    if (req.method === 'GET') {
      const action = new URL(req.url).searchParams.get('action')
      if (action === 'outlook_capabilities') {
        if (!opsAuthorized) {
          return json({ error: 'Operations credential required' }, 401)
        }
        // The MCP client pins this string exactly, so changing it makes every
        // Outlook action refuse until both sides deploy together. The
        // sender-only reply path was added without a bump for that reason:
        // deploy this function first, then the MCP server.
        return json({
          contract_version: '2026-09-09.1',
          actions: ['send', 'forward', 'reply', 'draft'],
          new_group_send: false,
        })
      }
      return json({ error: 'Unsupported capability query' }, 400)
    }
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

    try {
      const body = await req.json() as Record<string, unknown>
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new OutlookInputError(
          'invalid_request',
          'Request body must be an object',
        )
      }
      if (
        (body.action === 'reply' || body.action === 'draft') && !opsAuthorized
      ) {
        return json(
          { error: 'Operations credential required for this action' },
          401,
        )
      }
      // Classify before any provider call so a group sender can never fall
      // through to /users/{id}/sendMail.
      const route = classifyOutlookRoute(body)
      if (body.action === 'send_draft') {
        throw new OutlookInputError(
          'draft_send_requires_review',
          'Draft sending requires a reviewed action-specific workflow',
        )
      }
      if (
        body.action !== 'forward' && body.action !== 'reply' &&
        body.action !== 'draft' && body.action !== undefined
      ) {
        throw new OutlookInputError(
          'invalid_action',
          'Unsupported Outlook action',
        )
      }
      if (body.action !== 'reply') assertNoLegacyReplyFields(body)
      if (body.action !== 'forward' && route.kind === 'group') {
        throw new OutlookInputError(
          'group_route_required',
          'Group senders require the explicit group forward action',
        )
      }
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      await assertOutlookSesDeliveryAllowed(sb, body)
      if (route.kind === 'mailbox') await verifyMailboxRoute(route.mailbox)

      // ── Forward action — genuine Graph forward, preserves original body + attachments ──
      if (body.action === 'forward') {
        return await handleForward(body)
      }
      if (body.action === 'reply') return await handleReply(body)
      if (body.action === 'draft') return await handleDraft(body)

      const from = route.kind === 'mailbox' ? route.mailbox : DEFAULT_MAILBOX
      const to = splitRecipientInput(body.to, 'to', true)
      const cc = splitRecipientInput(body.cc, 'cc')
      const bcc = splitRecipientInput(body.bcc, 'bcc')
      const subject = nonEmptyString(body.subject, 'subject')
      const htmlBody = nonEmptyString(body.htmlBody, 'htmlBody')
      const message = messageContent({
        ...body,
        to,
        cc,
        bcc,
        subject,
        htmlBody,
      }, from)
      const graphAttachments = await prepareAttachments(body.attachments)
      if (graphAttachments.length) message.attachments = graphAttachments
      await graphRequest(`/users/${safeSegment(from, 'from')}/sendMail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: true }),
      }, { mutating: true })

      const toStr = to.join(', ')
      if (body.job_id) {
        Promise.resolve(
          sb.from('po_communications').insert({
            job_id: body.job_id,
            direction: 'outbound',
            from_email: from,
            to_email: toStr,
            cc_emails: cc.length ? cc : null,
            subject,
            body_html: htmlBody,
            communication_type: 'client',
            sent_at: new Date().toISOString(),
            created_by: body.sent_by || null,
          }),
        ).catch((e: any) => console.log('[send-outlook-email] po_comms log failed:', e?.message))
      }
      Promise.resolve(
        sb.from('email_events').insert({
          email_type: 'client_email',
          entity_type: body.job_id ? 'job' : 'contact',
          entity_id: body.job_id || body.ghl_contact_id || toStr,
          job_id: body.job_id || null,
          recipient: to[0],
          sender: from,
          subject,
          status: 'accepted',
          sent_at: new Date().toISOString(),
        }),
      ).catch(() => {})
      if (body.ghl_contact_id) {
        fetch(`${SUPABASE_URL}/functions/v1/ghl-proxy?action=add_note`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({
            contactId: body.ghl_contact_id,
            body: `Email accepted: "${subject}" to ${toStr}`,
          }),
        }).catch(() => {})
      }
      return acceptedResponse({
        success: true,
        from,
        to,
        cc,
        bcc,
        subject,
        attachments: graphAttachments.length,
      })
    } catch (err) {
      if (err instanceof OutlookFenceError) {
        return json(err.refusal, err.status)
      }
      if (err instanceof OutlookInputError) {
        return json(
          { error: err.message, code: err.code, retry_safe: true },
          400,
        )
      }
      if (err instanceof GraphProviderError) {
        if (err.outcomeUnknown) {
          return json({
            state: 'outcome_unknown',
            code: 'provider_outcome_unknown',
            error: err.message,
            retry_safe: false,
            ...err.context,
          }, 502)
        }
        return json({
          ...err.context,
          error: 'Graph API error',
          status: err.status || 502,
          detail: err.message,
          retry_safe: typeof err.context.retry_safe === 'boolean'
            ? err.context.retry_safe
            : true,
        }, 502)
      }
      console.error('[send-outlook-email] Error:', (err as Error).message)
      return json({ error: (err as Error).message, retry_safe: true }, 500)
    }
}

if (import.meta.main) serve(handleOutlookRequest)
