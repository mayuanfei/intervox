# InterVox 作用

​	intervox 可以理解为 international voice。是一款能把视频中语言转换为自己国家语言后重新生成一个新视频的工具。主要应用场景：

* 视频没有字幕。加上中文字幕。
* 最新的技术教学，往往是英文、德文、日文等，这里想直接在视频中讲解的就是中文。
* 讲解的中文，可以选择电子音。也可以是讲解者自己的声音。



# InterVox 桌面应用的功能

* 可以播放本地和网络视频。这个可以和 IINA 媲美的能力。这里强调可以播放任何视频。

* 可以下载视频到本地。这里能力和 Downie4媲美的能力。

* 能把本地的视频，从原语言转换为目标语言。我这里默认为中文。

* 进行转用到的大模型现在先定位为：阿里云百炼

    * 语音合成

        https://help.aliyun.com/zh/model-studio/tts-model/?spm=a2c4g.11186623.help-menu-2400256.d_0_3_5.6c1a78d7QmubJ8&scm=20140722.H_3026935._.OR_help-T_cn~zh-V_1

    * 语音识别

        https://help.aliyun.com/zh/model-studio/asr-model/?spm=a2c4g.11186623.help-menu-2400256.d_0_3_7.73862b07QkW77t&scm=20140722.H_3026929._.OR_help-T_cn~zh-V_1

    * 语音转语音

        https://help.aliyun.com/zh/model-studio/s2s-model?spm=a2c4g.11186623.help-menu-2400256.d_0_3_8.1ad678d7nkrzh3&scm=20140722.H_3026949._.OR_help-T_cn~zh-V_1

* 用户在进行转换英文视频到中文视频时，要选择本地的视频，或者网络可以访问的视频。

* 然后选择要使用的大模型。目前先仅仅支持百炼大模型。后面可以支持豆包大模型和本地大模型。

* 选择的视频，要经历的大体过程：选择本地视频->FFmpeg 抽取主音轨->生成标准音频文件->交给百炼识别->生成字幕-> FFmpeg amix 混成一条 voiceover.wav->生成最终视频这里最好有进度提示。

* 可选择是否保留原声音。如果保留原声音，可以选择音量百分百。默认是 25%。

* 最终语言也是可以选择的

* 声音也是可以选择百炼的默认电子音；这里可以选择视频原声音，意思就是用视频中本身的人声，通过百炼的声音复刻https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide?spm=a2c4g.11186623.help-menu-2400256.d_0_3_5_2.242d2b07XK8D1T&scm=20140722.H_3032823._.OR_help-T_cn~zh-V_1

    实现视频人物原声说转换后的语言。

* 可以设置视频最终生成的目录。默认是和原视频文件在一个目录下。