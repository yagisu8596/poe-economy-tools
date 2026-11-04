# PoE Economy Tools — v0.6.1 (veri katmanı + toplayıcı + Discord alarmları + Market sayfası)

Path of Exile 1 ekonomi aracı. Bu sürüm iki parçadan oluşur: Supabase'de zamanlanmış çalışan "veri motoru" (poe.ninja'dan fiyatları okuyup doğrular, arşivler, alarmları çalar) ve oyuncuların göreceği İngilizce Market sayfası (`web/`). Market sayfası henüz bir adreste yayında değil; barındırma seçimi bekliyor.

## Klasörler

| Yol | Ne yapar |
| --- | --- |
| `supabase/functions/_shared/normalize.ts` | poe.ninja yanıtını Chaos/Divine değerlerine çevirir. Divine/Chaos oranını doğrular, ters çevrilmiş veriyi reddeder. Eksik fiyat ve hacim `null` olur, asla 0 olmaz. Az işlem gören eşyalar "low confidence" diye etiketlenir. Haftalık trendi her eşyanın kendi çiftine göre okur. |
| `supabase/functions/_shared/collector.ts` | Toplayıcının çekirdeği. Lig listesini otomatik izler (yeni lig gelince kendiliğinden geçer). Önce Currency'yi çeker, Divine referansını diğer kategorilere taşır. ETag kullanır, istekler arasında bekler. Aynı kategoriyi kısa sürede iki kez çekmez. HTTP 429'da durur ve zaman sınırına uyar. |
| `supabase/functions/_shared/alerts.ts` | Çalan alarmları İngilizce Discord mesajlarına çevirir ve gönderir (webhook doğrulama, 429'da bekleyip tekrar deneme, 10'dan fazla alarmı mesajlara bölme). |
| `supabase/migrations/…_intraday_alerts.sql` | Gün içi değişim hesabı (1–24 saat; eski veriyle karşılaştırma yapmaz) ve alarm motoru: fiyat seviyesi (üstüne/altına) ve yüzde değişim (yükselirse/düşerse), tek eşya ya da tüm kategori, az işlem filtresi, tekrar bildirme süresi. |
| `supabase/functions/_shared/networth.ts` | Net değer değişimini "senin hareketin" ve "piyasa etkisi" olarak ikiye ayırır. |
| `supabase/functions/collect/index.ts` | Supabase Edge Function. Zamanlayıcı tarafından çağrılır, gizli bir token ister. |
| `supabase/migrations/…_market_data.sql` | Veritabanı: ligler, eşyalar, fiyat geçmişi, son fiyatlar, toplayıcı kayıtları. Kademeli saklama (ham 2 gün, saatlik 7 gün, günlük kalıcı) ve güvenlik kuralları (RLS). |
| `supabase/migrations/…_market_views.sql` | Market sayfasının okuduğu iki hazır sorgu: tüm eşyaların son fiyatı + 1s/6s/24s/7g değişimi, ve bir eşyanın seçilen aralıktaki fiyat çizgisi. Herkese açık anahtarla sadece okunabilir. |
| `supabase/migrations/…_hourly_cadence.sql` | poe.ninja'nın gerçek (yaklaşık saatlik) güncelleme ritmine uygun değişim hesabı ve alarmlar için “bir sonraki güncellemede de geçerliyse bildir” seçeneği. |
| `supabase/migrations/…_league_history.sql` | Geçmiş liglerin günlük fiyatları (poe.ninja veri arşivleri, CC BY-SA) ve “ligin aynı günü” karşılaştırması: `league_day_compare`, `league_day_series`. İçe aktarma yalnızca süreli bir tek kullanımlık anahtarla yapılabilir. |
| `scripts/league-history.js` | poe.ninja arşivini (zip) okuyup her lig ve eşya için günlük fiyat dizisi üreten içe aktarıcı. poe.ninja sekmesinde tarayıcıda çalışır. |
| `web/` | Market sayfası (PWA, telefona uygulama gibi eklenebilir): lig seçimi, en çok yükselen/düşenler, arama, kategori filtresi, az işlem gizleme, eşya detayında sade fiyat çizgisi (RSI/SMA yok), izleme listesi (★), eşya adını kopyalama, paylaşılabilir eşya bağlantısı (`#item-divine`), Esc ile kapatma, “Same day in past leagues” (ligin aynı gününde geçmiş liglerde chaos/divine fiyatı ve lig gününe göre çizgi grafik). Her 5 dakikada kendini yeniler. |
| `supabase/setup/schedule.sql` | Zamanlanmış görevler: güncel challenge softcore 15 dakikada bir; challenge HC, Standard ve Hardcore saatte bir; arşiv sıkıştırma saatlik ve gecelik. |
| `fixtures/` | 4 Kasım 2026, Allflame liginden gerçek poe.ninja verisi (kısaltılmış). |
| `test/` | 83 kod testi + Postgres 16 üzerinde şema, alarm ve kurulum sayfası SQL testleri. |

## Testler (geliştirici için)

```
npm test                                   # 83 test, Node 22.6+
PGHOST=… PGPORT=… PGUSER=postgres test/sql/run.sh       # şema + alarm testleri, geçici bir Postgres'te
PGHOST=… PGPORT=… PGUSER=postgres test/sql/page_sql.sh  # kurulum sayfasının ürettiği SQL (önce npm test)
node scripts/build-preview.mjs             # dist/snapshot.json'dan tek dosyalık Market önizlemesi
```

Market sayfasını yerelde açmak için `web/` klasörünü herhangi bir statik sunucuyla servis etmek yeter (ör. `npx serve web`). Supabase adresi ve herkese açık anahtar `web/config.js` içinde.

## poe.ninja alan anlamları (4 Kasım 2026'da gerçek veriyle doğrulandı)

- `core.rates.divine` = 1 Chaos'un kaç Divine ettiği. Divine fiyatı = 1 / bu değer.
- `primaryValue` = 1 adedin Chaos fiyatı.
- `volumePrimaryValue` = Chaos cinsinden işlem değeri, adet değil.
- `maxVolumeRate` = en çok işlem gören çifte karşı "1 birime kaç adet". Fiyat değil.
- `sparkline` = ~7 günlük kümülatif % değişim, eşyanın `maxVolumeCurrency` çiftine göre.
- Currency dışındaki kategorilerde Divine satırı yoktur; sadece `core.rates.divine` vardır.

## Değişiklikler

- v0.6.1: Karşılaştırmada poe.ninja'nın güvenilir fiyat vermediği günlerde en yakın gün (±3) gösteriliyor ve “day N” diye işaretleniyor. Önizlemede 12 popüler eşya için geçmiş lig verisi var.
- v0.6.0: Geçmiş liglerle aynı gün karşılaştırması. 6 lig (Mirage 3.28 → Affliction 3.23, softcore + hardcore) içe aktarıldı: 11.041 eşya-lig satırı, 7,3 MB. Kurulum sayfasına U4.
- v0.5.0: Ölçüm: poe.ninja kur fiyatlarını yaklaşık saatte bir yayınlıyor. 1 saatlik değişim artık bu ritme göre hesaplanıyor. Alarmlara sahte sıçrama koruması (confirm_next). Market sayfasına izleme listesi, ad kopyalama, eşya bağlantıları. Canlı sitede çıkacak iki hata düzeltildi (kategori adı fonksiyonu içe aktarılmamıştı; detay paneli kapanmıyordu). Kurulum sayfasına U3.
- v0.4.0: Market sayfası (İngilizce PWA) ve onu besleyen iki veritabanı sorgusu. Canlı Supabase'e uygulandı ve herkese açık anahtarla sadece okuma yapılabildiği doğrulandı. Kurulum sayfası yeni kurulumlarda bu sorguları da kuruyor.
- v0.3.0: Toplayıcı güncel ligi 15 dakikada bir çekiyor. Gün içi değişim hesabı, alarm motoru ve Discord bildirimleri. Kurulum sayfasına U1/U2 güncellemeleri ve alarm oluşturma formu.
- v0.2.1: Kurulum sayfası düzeltmesi (adres ve iletişim artık doğru yere yazılıyor) + regresyon testi. Supabase East US projesinde canlı; ilk çalışmada 642 eşya kaydedildi.
- v0.2.0: Supabase veritabanı şeması, toplayıcı ve zamanlanmış görevler. Kullanıcıya görünen metinler İngilizce. Gün/saat sınırları UTC'ye sabitlendi.
- v0.1.1: Trend her eşyanın kendi çiftine göre okunuyor (v1.0.0 prototipindeki ters yön hatası düzeltildi).
- v0.1.0: İlk veri katmanı.

---
This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
