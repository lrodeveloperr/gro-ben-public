#!/usr/bin/env ruby
# frozen_string_literal: true

require "base64"
require "bigdecimal"
require "date"
require "json"
require "net/http"
require "openssl"
require "uri"

key_path, key_id, issuer_id = ARGV
abort "Usage: app-store-connect-jwt.rb KEY_PATH KEY_ID ISSUER_ID" if
  [key_path, key_id, issuer_id].any? { |value| value.nil? || value.empty? }

def base64url(value)
  Base64.urlsafe_encode64(value, padding: false)
end

def app_store_get(path, jwt)
  uri = URI("https://api.appstoreconnect.apple.com#{path}")
  request = Net::HTTP::Get.new(uri)
  request["Authorization"] = "Bearer #{jwt}"
  request["Accept"] = "application/json"

  response = Net::HTTP.start(
    uri.host,
    uri.port,
    use_ssl: true,
    open_timeout: 10,
    read_timeout: 20,
  ) { |http| http.request(request) }

  unless response.is_a?(Net::HTTPSuccess)
    abort(
      "App Store Connect price verification failed (HTTP #{response.code}): " \
      "#{response.body.to_s.byteslice(0, 500)}"
    )
  end

  JSON.parse(response.body)
rescue JSON::ParserError => error
  abort "App Store Connect returned invalid JSON while verifying pricing: #{error.message}"
rescue StandardError => error
  abort "App Store Connect price verification failed: #{error.class}: #{error.message}"
end

def query_path(path, params)
  uri = URI(path)
  uri.query = URI.encode_www_form(params)
  uri.request_uri
end

def active_us_app_prices(document, source)
  price_points = document.fetch("included", []).filter_map do |resource|
    next unless resource["type"] == "appPricePoints"

    [
      resource.fetch("id"),
      resource.fetch("attributes", {}).fetch("customerPrice", nil),
    ]
  end.to_h

  currencies = document.fetch("included", []).filter_map do |resource|
    next unless resource["type"] == "territories"

    [
      resource.fetch("id"),
      resource.fetch("attributes", {}).fetch("currency", nil),
    ]
  end.to_h

  today = Date.today
  document.fetch("data", []).filter_map do |price|
    attributes = price.fetch("attributes", {})
    territory_id = price.dig("relationships", "territory", "data", "id")
    next unless territory_id == "USA"

    starts = attributes["startDate"] && Date.iso8601(attributes["startDate"])
    ends = attributes["endDate"] && Date.iso8601(attributes["endDate"])
    next if starts && starts > today
    next if ends && ends < today

    price_point_id = price.dig(
      "relationships",
      "appPricePoint",
      "data",
      "id",
    )
    customer_price = price_points[price_point_id]
    next if customer_price.nil?

    currency = currencies[territory_id]
    if currency && currency != "USD"
      abort "Unexpected U.S. App Store currency #{currency}; expected USD."
    end

    {
      source: source,
      starts: starts || Date.new(1, 1, 1),
      customer_price: BigDecimal(customer_price.to_s),
      manual: attributes["manual"] == true,
    }
  end
end

def verify_us_app_download_price(jwt)
  app_id = ENV["APP_STORE_ID"].to_s.strip
  return if app_id.empty?

  expected = BigDecimal(
    ENV.fetch("APP_DOWNLOAD_US_PRICE", "0.00").to_s,
  )

  schedule = app_store_get(
    "/v1/apps/#{URI.encode_www_form_component(app_id)}/appPriceSchedule",
    jwt,
  )
  schedule_id = schedule.dig("data", "id").to_s
  abort "App Store price schedule is missing for app #{app_id}." if schedule_id.empty?

  params = {
    "filter[territory]" => "USA",
    "include" => "appPricePoint,territory",
    "fields[appPrices]" => "manual,startDate,endDate,appPricePoint,territory",
    "fields[appPricePoints]" => "customerPrice",
    "fields[territories]" => "currency",
    "limit" => "200",
  }

  prices = []
  %w[automaticPrices manualPrices].each do |source|
    path = query_path(
      "/v1/appPriceSchedules/#{URI.encode_www_form_component(schedule_id)}/#{source}",
      params,
    )
    prices.concat(active_us_app_prices(app_store_get(path, jwt), source))
  end

  abort "No active U.S. App Store download price is configured." if prices.empty?

  # A manually chosen price wins over an automatic price when they share the
  # same effective date. Otherwise the most recently effective active price is
  # the current price.
  current = prices.max_by do |price|
    [price.fetch(:starts), price.fetch(:manual) ? 1 : 0]
  end
  actual = current.fetch(:customer_price)
  unless actual == expected
    abort(
      "App download U.S. price is #{actual.to_s("F")}, expected " \
      "#{expected.to_s("F")}. This app's commercial model is a free download " \
      "with a separate US$9.99 Remove Ads non-consumable."
    )
  end

  warn(
    "App Store commercial-model gate passed: U.S. app download " \
    "#{actual.to_s("F")} (#{current.fetch(:source)})."
  )
end

issued_at = Time.now.to_i
header = { alg: "ES256", kid: key_id, typ: "JWT" }
payload = {
  iss: issuer_id,
  iat: issued_at,
  exp: issued_at + 900,
  aud: "appstoreconnect-v1",
}

signing_input = [header, payload]
  .map { |value| base64url(JSON.generate(value)) }
  .join(".")

private_key = OpenSSL::PKey.read(File.binread(key_path))
abort "The supplied App Store Connect key is not an EC private key." unless
  private_key.is_a?(OpenSSL::PKey::EC) && private_key.private?

der_signature = private_key.sign(OpenSSL::Digest::SHA256.new, signing_input)
components = OpenSSL::ASN1.decode(der_signature).value
abort "Unexpected ECDSA signature structure." unless components.length == 2

raw_signature = components.map do |component|
  hex = component.value.to_i.to_s(16)
  abort "Unexpected ECDSA signature component length." if hex.length > 64
  [hex.rjust(64, "0")].pack("H*")
end.join

jwt = "#{signing_input}.#{base64url(raw_signature)}"
verify_us_app_download_price(jwt)
puts jwt
