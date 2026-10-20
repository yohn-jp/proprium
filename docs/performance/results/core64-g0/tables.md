| Dataset / operation | Worker status | n | p50 ms | p95 ms | p99 ms | Node CPU p50 ms | RSS max MiB | Git p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mutation-large / mutation.prepare | complete | 5 | 604.84 | 662.99 | 662.99 | 607.01 | 272.20 | 23 |
| mutation-large / proposal | complete | 5 | 170.53 | 271.17 | 271.17 | 87.81 | 273.57 | 28 |
| mutation-large / approval | complete | 5 | 153.96 | 241.40 | 241.40 | 65.40 | 275.95 | 21 |
| mutation-large / checkpoint | complete | 5 | 654.95 | 823.93 | 823.93 | 208.55 | 278.20 | 96 |
| mutation-large / publish | complete | 5 | 932.20 | 1262.43 | 1262.43 | 310.16 | 275.63 | 149 |
| mutation-medium / mutation.prepare | complete | 5 | 192.20 | 242.74 | 242.74 | 157.17 | 160.89 | 22 |
| mutation-medium / proposal | complete | 5 | 165.17 | 264.19 | 264.19 | 72.65 | 162.39 | 28 |
| mutation-medium / approval | complete | 5 | 134.26 | 235.49 | 235.49 | 53.36 | 164.52 | 21 |
| mutation-medium / checkpoint | complete | 5 | 547.56 | 763.43 | 763.43 | 214.41 | 166.77 | 96 |
| mutation-medium / publish | complete | 5 | 880.08 | 1156.79 | 1156.79 | 303.80 | 163.64 | 149 |
| mutation-small / mutation.prepare | complete | 5 | 124.70 | 198.21 | 198.21 | 72.07 | 118.10 | 22 |
| mutation-small / proposal | complete | 5 | 157.35 | 287.63 | 287.63 | 74.87 | 119.85 | 28 |
| mutation-small / approval | complete | 5 | 140.22 | 254.87 | 254.87 | 64.69 | 121.22 | 21 |
| mutation-small / checkpoint | complete | 5 | 542.65 | 811.83 | 811.83 | 185.62 | 128.97 | 96 |
| mutation-small / publish | complete | 5 | 897.46 | 1251.29 | 1251.29 | 312.62 | 133.06 | 149 |
| mutation-stress / mutation.prepare | complete | 5 | 8958.70 | 9351.35 | 9351.35 | 8768.51 | 547.21 | 34 |
| mutation-stress / proposal | complete | 5 | 209.68 | 358.13 | 358.13 | 112.85 | 543.01 | 28 |
| mutation-stress / approval | complete | 5 | 181.60 | 307.81 | 307.81 | 78.90 | 544.39 | 21 |
| mutation-stress / checkpoint | complete | 5 | 1314.92 | 1507.74 | 1507.74 | 306.35 | 545.76 | 96 |
| mutation-stress / publish | complete | 5 | 1412.21 | 3161.07 | 3161.07 | 428.48 | 547.14 | 149 |
| read-large / tree.cold | complete | 1 | 591.90 | 591.90 | 591.90 | 765.75 | 129.70 | 10 |
| read-large / tree.warm | complete | 20 | 43.89 | 50.28 | 53.65 | 23.43 | 158.34 | 6 |
| read-large / snapshot.scene | complete | 20 | 48.41 | 59.89 | 61.08 | 23.27 | 158.34 | 7 |
| read-medium / tree.cold | complete | 1 | 135.37 | 135.37 | 135.37 | 153.82 | 84.64 | 9 |
| read-medium / tree.warm | complete | 20 | 39.42 | 41.92 | 43.50 | 18.25 | 110.53 | 6 |
| read-medium / snapshot.scene | complete | 20 | 46.00 | 53.90 | 53.99 | 22.85 | 110.65 | 7 |
| read-small / tree.cold | complete | 1 | 73.67 | 73.67 | 73.67 | 47.95 | 75.76 | 9 |
| read-small / tree.warm | complete | 20 | 39.75 | 43.78 | 44.15 | 19.50 | 103.66 | 6 |
| read-small / snapshot.scene | complete | 20 | 46.31 | 52.99 | 60.76 | 23.80 | 104.54 | 7 |
| read-stress / tree.cold | NOT_CHECKED | 1 | 9333.29 | 9333.29 | 9333.29 | 9318.48 | 357.43 | 21 |
| read-stress / tree.warm | NOT_CHECKED | 9 | 8777.25 | 9057.12 | 9057.12 | 8635.41 | 692.49 | 21 |
| read-stress / snapshot.scene | NOT_CHECKED | 9 | 8722.74 | 9003.86 | 9003.86 | 8553.97 | 724.98 | 22 |
| revisions-large / reader.create | complete | 1 | 43.90 | 43.90 | 43.90 | 25.60 | 72.70 | 6 |
| revisions-large / reader.list | complete | 1 | 21.18 | 21.18 | 21.18 | 21.69 | 78.45 | 1 |
| revisions-large / reader.listRevisions.cold | complete | 1 | 441.57 | 441.57 | 441.57 | 507.51 | 119.20 | 5 |
| revisions-large / reader.listRevisions.warm | complete | 1 | 43.86 | 43.86 | 43.86 | 57.06 | 129.57 | 1 |
| revisions-medium / reader.create | complete | 1 | 39.78 | 39.78 | 39.78 | 22.90 | 71.63 | 6 |
| revisions-medium / reader.list | complete | 1 | 11.95 | 11.95 | 11.95 | 8.44 | 74.38 | 1 |
| revisions-medium / reader.listRevisions.cold | complete | 1 | 67.14 | 67.14 | 67.14 | 66.69 | 82.09 | 3 |
| revisions-medium / reader.listRevisions.warm | complete | 1 | 8.42 | 8.42 | 8.42 | 4.76 | 82.09 | 1 |
| revisions-small / reader.create | complete | 1 | 40.10 | 40.10 | 40.10 | 23.91 | 72.64 | 6 |
| revisions-small / reader.list | complete | 1 | 11.44 | 11.44 | 11.44 | 7.84 | 75.39 | 1 |
| revisions-small / reader.listRevisions.cold | complete | 1 | 22.70 | 22.70 | 22.70 | 13.30 | 77.64 | 3 |
| revisions-small / reader.listRevisions.warm | complete | 1 | 6.80 | 6.80 | 6.80 | 3.11 | 77.76 | 1 |
| revisions-stress / reader.create | complete | 1 | 40.94 | 40.94 | 40.94 | 24.46 | 71.75 | 6 |
| revisions-stress / reader.list | complete | 1 | 129.25 | 129.25 | 129.25 | 140.62 | 119.39 | 1 |
| revisions-stress / reader.listRevisions.cold | complete | 1 | 4224.63 | 4224.63 | 4224.63 | 4471.60 | 325.10 | 27 |
| revisions-stress / reader.listRevisions.warm | complete | 1 | 3586.96 | 3586.96 | 3586.96 | 3788.70 | 433.32 | 23 |
| search-medium / search.scan | complete | 1 | 35912.40 | 35912.40 | 35912.40 | 13061.59 | 212.49 | 6492 |
| search-small / search.scan | complete | 1 | 326.48 | 326.48 | 326.48 | 153.69 | 80.58 | 59 |
| stats-medium / stats.scan | complete | 1 | 35680.49 | 35680.49 | 35680.49 | 12880.83 | 212.70 | 6491 |
| stats-small / stats.scan | complete | 1 | 324.75 | 324.75 | 324.75 | 160.12 | 78.60 | 58 |

| Dataset / document | Worker status | typing n | typing p50 / p95 / p99 ms | arrow p95 ms | React commits | Long Tasks n / p95 ms | strict IDB n / p95 ms | getAll calls |
| --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: |
| browser-large / input.1024 / scene-1 | complete | 20 | 7.00 / 7.80 / 11.90 | 14.20 | 12 | 1 / 212.00 | 2 / 34.20 | 2 |
| browser-large / input.102400 / scene-2 | complete | 20 | 55.00 / 57.40 / 57.60 | 55.80 | 11 | 45 / 56.00 | 2 / 40.30 | 2 |
| browser-large / input.1048576 / scene-3 | complete | 20 | 491.30 / 532.90 / 591.90 | 528.00 | 94 | 92 / 530.00 | 22 / 244.50 | 30 |
| browser-medium / input.1024 / scene-1 | complete | 20 | 7.60 / 8.80 / 18.00 | 15.40 | 13 | 1 / 169.00 | 2 / 7.80 | 4 |
| browser-medium / input.102400 / scene-2 | complete | 20 | 67.20 / 69.30 / 70.90 | 62.20 | 11 | 39 / 69.00 | 2 / 21.70 | 2 |
| browser-medium / input.1048576 / scene-3 | complete | 20 | 502.20 / 579.10 / 610.90 | 555.30 | 104 | 88 / 550.00 | 23 / 778.90 | 35 |
| browser-small / input.1024 / scene-1 | complete | 20 | 7.90 / 9.40 / 9.80 | 6.40 | 17 | 1 / 154.00 | 3 / 5.60 | 5 |
| browser-small / input.102400 / scene-2 | complete | 20 | 53.50 / 55.80 / 56.20 | 55.50 | 11 | 33 / 56.00 | 2 / 18.90 | 2 |
| browser-small / input.1048576 / scene-3 | complete | 20 | 510.70 / 576.60 / 626.70 | 606.90 | 96 | 76 / 606.00 | 22 / 222.00 | 30 |
