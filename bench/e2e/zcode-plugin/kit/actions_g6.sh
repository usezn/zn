xdotool mousemove 720 607 click 1; sleep 3
xdotool mousemove 720 674 click 1; sleep 4
xdotool mousemove 413 802 click 1; sleep 2
xdotool mousemove 413 802 click 1; sleep 2
xdotool mousemove 413 802 click 1; sleep 3
xdotool mousemove 660 130 click 1; sleep 3
xdotool key ctrl+comma; sleep 2
xdotool mousemove 228 130 click 1; sleep 3
xdotool key ctrl+o; sleep 3
xdotool key ctrl+l; sleep 1
xdotool type --delay 40 "/work/proj"; sleep 1
xdotool key Return; sleep 2
xdotool mousemove 1075 798 click 1; sleep 3; shot project_selected
xdotool mousemove 229 198 click 1; sleep 4
xdotool mousemove 1093 143 click 1; sleep 2
xdotool mousemove 1100 212 click 1; sleep 3
xdotool type --delay 40 "/work/market"; sleep 1
xdotool key Return; sleep 6
xdotool mousemove 644 197 click 1; sleep 4
xdotool mousemove 794 313 click 1; sleep 8
xdotool key ctrl+comma; sleep 3
xdotool mousemove 187 566 click 1; sleep 4; shot plugins_on
xdotool mousemove 1236 308 click 1; sleep 4; shot plugins_toggled_off
cp /work/guihome/.zcode/cli/config.json "$OUT/config_after_toggle_off.json"
xdotool mousemove 228 130 click 1; sleep 3
xdotool key ctrl+n; sleep 3
xdotool mousemove 845 478 click 1; sleep 1
xdotool type --delay 40 "run the test"; sleep 1
xdotool key Return; sleep 15; shot task_after_off
sleep 10; shot task_after_off2
xdotool key ctrl+comma; sleep 3
xdotool mousemove 187 566 click 1; sleep 4
xdotool mousemove 489 297 click 1; sleep 4; shot plugin_detail
